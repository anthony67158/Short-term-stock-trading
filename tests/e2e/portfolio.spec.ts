import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

test("账户资金闭环、刷新、隔离、深浅主题与四视口", async ({ browser, playwright }) => {
  const identity = JSON.parse(execFileSync("uv", [
    "run", "python", "tests/provision_browser.py",
  ], { cwd: "backend", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const auth = await playwright.request.newContext({
    baseURL: "http://localhost:5173", extraHTTPHeaders: { Origin: "http://localhost:5173" },
  });
  let context;
  try {
    // Establish a real, isolated test session without typing or exposing credentials.
    const login = await auth.post("/api/v1/sessions", {
      data: { username: identity.username, password: identity.password },
    });
    expect(login.status()).toBe(200);
    context = await browser.newContext({
      storageState: await auth.storageState(), viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("422"))
        errors.push(message.text());
    });
    await page.goto("http://localhost:5173/portfolio");
    await page.getByRole("button", { name: "创建账户", exact: true }).click();
    await page.getByLabel("账户名称").fill("浏览器合成账户");
    await page.getByRole("button", { name: "创建账户", exact: true }).last().click();
    await expect(page.getByText("现金余额 · 人民币")).toBeVisible();
    await page.getByRole("button", { name: "录入资金", exact: true }).click();
    await page.getByLabel("金额（元）", { exact: true }).fill("10000.01");
    await page.getByLabel("凭据或来源说明").fill("合成期初凭据");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.locator(".balance-value")).toHaveText("10,000.01");
    await expect(page.getByText("合成期初凭据", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator(".balance-value")).toHaveText("10,000.01");
    await page.getByRole("button", { name: "录入资金", exact: true }).click();
    await page.getByLabel("资金类型").selectOption("WITHDRAWAL");
    await page.getByLabel("金额（元）", { exact: true }).fill("20000");
    await page.getByLabel("凭据或来源说明").fill("合成出金凭据");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.getByRole("alert")).toHaveText("出金金额超过现金余额");
    await page.getByLabel("金额（元）", { exact: true }).fill("200.02");
    await page.getByRole("button", { name: "保存资金记录" }).click();
    await expect(page.locator(".balance-value")).toHaveText("9,799.99");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "切换深浅主题" }).click();
      for (const width of [390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await expect(page.locator(".balance-value")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: `test-results/cash-${theme}-${width}.png`, fullPage: true });
      }
    }
    expect(errors).toEqual([]);
    await page.getByRole("link", { name: "市场与选股", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索股票" }).fill("000001");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await page.getByRole("link", { name: "平安银行", exact: true }).click();
    await expect(page.getByRole("heading", { name: "行情快照" })).toBeVisible();
    await expect(page.locator(".quote-strip strong").first()).not.toBeEmpty({ timeout: 15_000 });
    await page.getByRole("button", { name: "加入关注", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已加入关注" })).toBeVisible();
    await page.getByRole("link", { name: "返回市场" }).click();
    await page.getByRole("button", { name: "我的关注" }).click();
    await expect(page.getByRole("link", { name: "平安银行", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "我的关注" }).click();
    await page.getByRole("link", { name: "平安银行", exact: true }).click();
    await page.getByRole("button", { name: "移出关注", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已移出关注" })).toBeVisible();
    await page.getByRole("button", { name: "添加研究材料" }).click();
    await page.getByLabel("材料标题").fill("合成浏览器研究材料");
    await page.getByLabel("原文链接（HTTPS）").fill("https://example.com/synthetic-evidence");
    await page.getByLabel("原文发布时间").fill("2026-09-14T10:00");
    await page.getByLabel("原文内容", { exact: true }).fill("这是用于浏览器验收的合成材料。订单需要进一步核验，不代表任何真实公司信息。");
    await page.getByLabel("引用片段（须与原文一致）").fill("订单需要进一步核验，不代表任何真实公司信息。");
    await page.getByRole("button", { name: "保存材料", exact: true }).click();
    await expect(page.locator("summary").filter({ hasText: "合成浏览器研究材料" })).toBeVisible();
    await page.reload();
    await page.locator("summary").filter({ hasText: "合成浏览器研究材料" }).click();
    await expect(page.getByRole("blockquote")).toContainText("订单需要进一步核验");
    await page.getByLabel("用于本次研究").check();
    await expect(page.getByRole("button", { name: "开始证据研究" })).toBeDisabled();
    await expect(page.getByText("研究推理服务尚未启用；请先完成供应商鉴权验证")).toBeVisible();
    expect(errors).toEqual([]);
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeVisible();
    await expect(page.getByText("合成期初凭据", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "登录工作区" })).toBeVisible();
  } finally {
    await context?.close();
    await auth.dispose();
    execFileSync("uv", ["run", "python", "tests/provision_browser.py", identity.userId], {
      cwd: "backend", stdio: ["ignore", "pipe", "pipe"],
    });
  }
});
