import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

test("期初持仓不扣现金、刷新、卖出FIFO与独立核对", async ({ browser, playwright }) => {
  const identity = JSON.parse(execFileSync("uv", ["run", "python", "tests/provision_browser.py"],
    { cwd: "backend", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const auth = await playwright.request.newContext({
    baseURL: "http://localhost:5173", extraHTTPHeaders: { Origin: "http://localhost:5173" },
  });
  let context;
  try {
    expect((await auth.post("/api/v1/sessions", {
      data: { username: identity.username, password: identity.password },
    })).status()).toBe(200);
    context = await browser.newContext({ storageState: await auth.storageState(),
      timezoneId: "Asia/Shanghai", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://localhost:5173/portfolio");
    await page.getByRole("button", { name: "创建账户", exact: true }).click();
    await page.getByLabel("账户名称").fill("期初合成账户");
    await page.getByRole("button", { name: "创建账户", exact: true }).last().click();
    await expect(page.locator(".balance-value")).toHaveText("0");
    await page.getByRole("button", { name: "录入期初持仓", exact: true }).click();
    const local = (days = 0) => new Date(Date.now() + 8 * 3600_000 - days * 86400_000).toISOString().slice(0, 19);
    await page.getByLabel("期初证券代码").fill("000001");
    await page.getByLabel("期初股数", { exact: true }).fill("37");
    await page.getByLabel("期初剩余总成本（元）").fill("375.01");
    await page.getByLabel("股份取得日（上海日期）").fill(local(10).slice(0, 10));
    await page.getByLabel("持仓基准时间（本设备时区）").fill(local(2));
    await page.getByLabel("期初批次凭据编号").fill("synthetic-opening-1");
    await page.getByLabel("期初持仓凭据说明").fill("合成券商期初批次");
    await page.getByRole("button", { name: "保存期初持仓", exact: true }).click();
    await expect(page.getByText("期初持仓已保存，现金未变动。")).toBeVisible();
    await expect(page.locator(".balance-value")).toHaveText("0");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("37 / 37");
    await expect(page.getByText("尚无已记录成交。")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "期初批次，可横向滚动" })).toContainText("375.01");
    await page.getByRole("button", { name: "录入成交", exact: true }).click();
    await page.getByLabel("证券代码（6位）").fill("000001");
    await page.getByLabel("成交方向").selectOption("SELL");
    await page.getByLabel("实际成交股数").fill("12");
    await page.getByLabel("成交价格（元）").fill("12");
    await page.getByLabel("成交时间", { exact: true }).fill(local());
    await page.getByLabel("实际佣金（元）").fill("1");
    await page.getByLabel("实际印花税（元）").fill("0");
    await page.getByLabel("实际过户费（元）").fill("0");
    await page.getByLabel("其他实际费用（元）").fill("0");
    await page.getByLabel("交割编号（账户内唯一）").fill("synthetic-opening-sale");
    await page.getByLabel("成交凭据说明").fill("合成期初卖出");
    await page.getByRole("button", { name: "保存成交事实" }).click();
    await expect(page.locator(".balance-value")).toHaveText("143.00");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("253.39");
    await expect(page.getByRole("region", { name: "成交明细，可横向滚动" })).toContainText("21.38");
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await expect(page.getByText("包含 1 个期初取得批次。")).toBeVisible();
    for (const [kind, amount, balance, reference] of [
      ["CASH_DIVIDEND", "12.34", "155.34", "synthetic-dividend"],
      ["DIVIDEND_TAX", "2.47", "152.87", "synthetic-tax"],
    ]) {
      await page.getByRole("button", { name: "录入资金", exact: true }).click();
      await page.getByLabel("资金类型").selectOption(kind);
      await page.getByLabel("金额（元）", { exact: true }).fill(amount);
      await page.getByLabel("凭据或来源说明").fill("合成公司行动现金凭据");
      await page.getByLabel("公司行动证券代码").fill("000001");
      await page.getByLabel("公司行动现金凭据编号").fill(reference);
      await page.getByRole("button", { name: "保存资金记录" }).click();
      await expect(page.locator(".balance-value")).toHaveText(balance);
    }
    await page.reload();
    await expect(page.locator(".balance-value")).toHaveText("152.87");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("253.39");
    await expect(page.getByRole("region", { name: "资金流水，可横向滚动" })).toContainText("红利补税");
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "冲正", exact: true }).click();
    await page.getByLabel("冲正方式").selectOption("REPLACE");
    await page.getByLabel("冲正原因", { exact: true }).fill("合成卖出价格及股数修订");
    await page.getByLabel("更正后股数", { exact: true }).fill("10");
    await page.getByLabel("更正后价格（元）").fill("13");
    await page.getByRole("button", { name: "预览冲正影响" }).click();
    await expect(page.getByRole("region", { name: "成交冲正", exact: true })).toContainText("152.87 → 138.87");
    await page.screenshot({ path: "test-results/replacement-preview.png", fullPage: true });
    await page.getByRole("button", { name: "确认冲正这笔成交" }).click();
    await expect(page.getByText("成交已冲正，持仓与现金已更新，原始凭据已保留。")).toBeVisible();
    await page.getByRole("button", { name: "关闭冲正结果" }).click();
    await page.reload();
    await expect(page.locator(".balance-value")).toHaveText("138.87");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("27 / 27");
    await expect(page.getByRole("region", { name: "持仓明细，可横向滚动" })).toContainText("273.66");
    await expect(page.getByRole("region", { name: "成交明细，可横向滚动" })).toContainText("27.65");
    await expect(page.getByRole("region", { name: "冲正记录，可横向滚动" })).toContainText("更正为 10 股");
    await page.getByRole("button", { name: "核对账本", exact: true }).click();
    await expect(page.getByText("账本核对一致", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "test-results/opening-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await auth.dispose();
    execFileSync("uv", ["run", "python", "tests/provision_browser.py", identity.userId],
      { cwd: "backend", stdio: ["ignore", "pipe", "pipe"] });
  }
});
