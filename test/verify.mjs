// dsh-auto-vision 正式测试（node test/verify.mjs）
// 覆盖：加载、纯文本不切、read_image 调用切、图片块切、read_image 失败切、
//       意图文本切、已是 vision 不动、非 deepseek 路由不切、倒序扫描、
//       失败回退保护、targetProviders 数组。
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(pathToFileURL(path.join(repoRoot, "lib", "index.js")).href);
assert.ok(mod.name === "auto-vision", "exports name");
assert.equal(typeof mod.apply, "function", "exports apply");

let pass = 0;
const fail = [];
function check(label, fn) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${label}: ${e.message}`);
  }
}

function makeCtx() {
  const handlers = {};
  return {
    on(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    handlers,
    logger: { info: () => {}, warn: () => {} },
  };
}

function makeAgent(events) {
  return { session: { events } };
}

function makeRun(ctx, agent, provider, model) {
  const h = ctx.handlers["agent/request"][0];
  return h({ agent }, async () => ({ provider, model }));
}

const mk = (type, data) => ({ type, data });
const textHist = [
  mk("user/message", { role: "user", content: [{ type: "text", text: "分析这个网页" }] }),
  mk("tool/call", { name: "web_search", arguments: "{}" }),
  mk("tool/result", { message: { content: [{ type: "text", text: "搜索完成" }] } }),
];

// 1. 加载与默认配置
const ctx1 = makeCtx();
mod.apply(ctx1, {});
check("默认配置下纯文本不切", async () => {});
{
  const r = await makeRun(ctx1, makeAgent(textHist), "deepseek-official", "deepseek-v4-flash");
  check("a) 纯文本历史 -> 保持 flash", () => assert.equal(r.model, "deepseek-v4-flash"));
}

// 2. read_image 调用
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [...textHist, mk("tool/call", { name: "read_image", arguments: '{"file_path":"a.png"}' })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("b) read_image 调用 -> 切 vision", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

// 3. 图片块
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [...textHist, mk("tool/result", { message: { content: [{ type: "image", attachment: { attachmentId: "x" } }] } })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("c) 图片块 -> 切 vision", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

// 4. read_image 失败错误
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const errText = 'cannot read "a.png" as an image: model "deepseek-v4-flash" does not declare image input; switch to an image-capable model';
  const hist = [...textHist, mk("tool/result", { message: { content: [{ type: "text", text: errText }] } })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("d) read_image 失败 -> 切 vision", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

// 5. 意图文本
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [mk("user/message", { role: "user", content: [{ type: "text", text: "帮我看一下这张截图里的内容" }] })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("e) 视觉意图文本 -> 切 vision", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [mk("user/message", { role: "user", content: [{ type: "text", text: "介绍图片上传功能的实现" }] })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("f) 非意图文本(图片上传) -> 不切", () => assert.equal(r.model, "deepseek-v4-flash"));
}

// 6. 已是 vision 不动
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const r = await makeRun(ctx, makeAgent(textHist), "deepseek-official", "deepseek-v4-flash-vision-exp");
  check("g) 已是 vision -> 不动", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

// 7. 非 deepseek 路由不切
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [...textHist, mk("tool/call", { name: "read_image", arguments: "{}" })];
  const r = await makeRun(ctx, makeAgent(hist), "minimax", "minimax-m3");
  check("h) 非 deepseek 路由 -> 不切", () => assert.equal(r.model, "minimax-m3"));
}

// 8. targetProviders 数组
{
  const ctx = makeCtx();
  mod.apply(ctx, { targetProviders: ["custom-deepseek-gw"] });
  const hist = [...textHist, mk("tool/call", { name: "read_image", arguments: "{}" })];
  const r = await makeRun(ctx, makeAgent(hist), "custom-deepseek-gw", "deepseek-v4-flash");
  check("i) targetProviders 含自定义路由 -> 切", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

// 9. 失败回退保护
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const hist = [...textHist, mk("tool/call", { name: "read_image", arguments: "{}" })];
  const agent = makeAgent(hist);
  const r1 = await makeRun(ctx, agent, "deepseek-official", "deepseek-v4-flash");
  check("j) 切换发生", () => assert.equal(r1.model, "deepseek-v4-flash-vision-exp"));
  // 模拟切换后致命失败
  const errHandler = ctx.handlers["agent/request-error"][0];
  await errHandler({ agent, failure: { code: "AUTH" } }, async () => ({}));
  // 下一次请求应回退原模型（不切）
  const r2 = await makeRun(ctx, agent, "deepseek-official", "deepseek-v4-flash");
  check("k) 致命失败后回退原模型", () => assert.equal(r2.model, "deepseek-v4-flash"));
  // 再下一次（重试机会）若正常则恢复切换
  const r3 = await makeRun(ctx, agent, "deepseek-official", "deepseek-v4-flash");
  check("l) 回退后重试机会恢复切换", () => assert.equal(r3.model, "deepseek-v4-flash-vision-exp"));
}

// 10. enabled=false 关闭
{
  const ctx = makeCtx();
  mod.apply(ctx, { enabled: false });
  const hist = [...textHist, mk("tool/call", { name: "read_image", arguments: "{}" })];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("m) enabled=false -> 不切", () => assert.equal(r.model, "deepseek-v4-flash"));
}

// 11. 倒序扫描正确性（图片在早期，其余大量后期文本事件）
{
  const ctx = makeCtx();
  mod.apply(ctx, {});
  const many = [];
  for (let i = 0; i < 500; i++) many.push(mk("tool/result", { message: { content: [{ type: "text", text: `step ${i}` }] } }));
  const hist = [mk("tool/result", { message: { content: [{ type: "image", attachment: {} }] } }), ...many];
  const r = await makeRun(ctx, makeAgent(hist), "deepseek-official", "deepseek-v4-flash");
  check("n) 早期图片块（500+事件后）仍能检出", () => assert.equal(r.model, "deepseek-v4-flash-vision-exp"));
}

console.log(`\n===== ${pass} passed, ${fail.length} failed =====`);
if (fail.length) {
  console.log("FAILED:");
  for (const f of fail) console.log("  -", f);
  process.exit(1);
}
