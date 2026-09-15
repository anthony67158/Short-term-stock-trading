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
