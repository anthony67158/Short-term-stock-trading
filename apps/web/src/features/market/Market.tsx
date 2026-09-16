import { useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Star } from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { Button, Empty, Input } from "../../components/Controls";
import { EvidenceResearch } from "./EvidenceResearch";
import { CandidateScan } from "./CandidateScan";

const boardNames = { MAIN: "主板", STAR: "科创板", CHINEXT: "创业板", BEIJING: "北交所", UNKNOWN: "待核验" };

export function Market() {
  const cache = useQueryClient();
  const command = useRef("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [watchOnly, setWatchOnly] = useState(false);
  const [viewName, setViewName] = useState("");
  const views = useQuery({
    queryKey: ["market-saved-views"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/market/saved-views", { signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data.views;
    },
  });
  const saveView = useMutation({
    mutationFn: async () => {
      command.current = crypto.randomUUID();
      const result = await api.POST("/api/v1/market/saved-views", {
        params: { header: { "Idempotency-Key": command.current } },
        body: {
          name: viewName.trim(),
          query,
          watchOnly,
        },
      });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    onSuccess: async () => {
      setViewName("");
      await cache.invalidateQueries({ queryKey: ["market-saved-views"] });
    },
  });
  const removeView = useMutation({
    mutationFn: async (viewId: string) => {
      const result = await api.DELETE(
        "/api/v1/market/saved-views/{view_id}",
        { params: { path: { view_id: viewId } } },
      );
      if (!result.response.ok) throw new Error(errorMessage(result.error));
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["market-saved-views"] });
    },
  });
  const listing = useInfiniteQuery({
    queryKey: ["instruments", query, watchOnly], initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      if (watchOnly) {
        const result = await api.GET("/api/v1/watchlists", { signal, params: { query: { cursor: pageParam, limit: 50 } } });
        if (!result.data) throw new Error(errorMessage(result.error));
        return { ...result.data.data, universe: null };
      }
      const result = await api.GET("/api/v1/instruments", { signal, params: { query: { query, cursor: pageParam, limit: 50 } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = listing.data?.pages.flatMap((page) => page.instruments) ?? [];
  const universe = listing.data?.pages[0]?.universe;
  return <><header className="workspace-header"><h1>市场与选股</h1><span className="secondary">证券目录与关注列表</span></header>
    <div className="workspace-content">
      <form className="market-toolbar" onSubmit={(event) => { event.preventDefault(); setWatchOnly(false); setQuery(draft.trim()); }}>
        <Input id="stock-search" label="搜索股票" type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="名称或六位代码" maxLength={80} />
        <Button type="submit" variant="primary">搜索</Button>
        <Button type="button" aria-pressed={watchOnly} onClick={() => setWatchOnly(!watchOnly)}><Star size={16} />{watchOnly ? "查看全部" : "我的关注"}</Button>
      </form>
      <div className="saved-view-toolbar">
        <label className="field compact-select">
          <span>保存视图</span>
          <select
            value=""
            onChange={(event) => {
              const view = views.data?.find(
                (item) => item.id === event.target.value,
              );
              if (!view) return;
              setDraft(view.query);
              setQuery(view.query);
              setWatchOnly(view.watchOnly);
            }}
          >
            <option value="">选择已保存条件</option>
            {views.data?.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          id="saved-view-name"
          label="新视图名称"
          value={viewName}
          onChange={(event) => setViewName(event.target.value)}
          maxLength={80}
        />
        <Button
          disabled={!viewName.trim() || saveView.isPending}
          onClick={() => saveView.mutate()}
        >
          保存当前条件
        </Button>
        {(views.data?.length ?? 0) > 0 && (
          <details className="saved-view-list">
            <summary>管理</summary>
            {views.data?.map((view) => (
              <div key={view.id}>
                <span>{view.name}</span>
                <Button
                  variant="ghost"
                  disabled={removeView.isPending}
                  onClick={() => removeView.mutate(view.id)}
                >
                  删除
                </Button>
              </div>
            ))}
          </details>
        )}
      </div>
      {(saveView.isError || removeView.isError || views.isError) && (
        <p className="error" role="alert">
          {errorMessage(saveView.error ?? removeView.error ?? views.error)}
        </p>
      )}
      {universe && <p className="source-note">{universe.source} · 当前目录 {universe.count.toLocaleString()} 只 · 采集于 {new Date(universe.acquiredAt).toLocaleString("zh-CN")} · 历史股票池待补齐</p>}
      <CandidateScan />
      {listing.isPending ? <p role="status">正在读取证券目录…</p> : listing.isError ? <div role="alert"><p>{errorMessage(listing.error)}</p><Button onClick={() => listing.refetch()}>重新读取</Button></div>
        : rows.length === 0 ? <Empty title={watchOnly ? "尚未关注股票" : "暂无匹配的证券"}>{watchOnly ? "打开股票详情后加入关注。" : universe ? "换一个名称或完整代码试试。" : "证券目录尚未完成同步。"}</Empty>
          : <div className="table-scroll" tabIndex={0} role="region" aria-label="股票列表"><table><thead><tr><th>股票</th><th>代码</th><th>交易市场</th><th>板块</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
            <td><Link to={`/research/${row.id}`}>{row.name}</Link></td><td>{row.code}</td><td>{row.exchange === "SH" ? "上海" : row.exchange === "SZ" ? "深圳" : "北京"}</td><td>{boardNames[row.board]}</td>
          </tr>)}</tbody></table></div>}
      {listing.hasNextPage && <Button disabled={listing.isFetchingNextPage} onClick={() => listing.fetchNextPage()}>加载更多股票</Button>}
    </div>
  </>;
}

export function Research() {
  const { instrumentId } = useParams();
  return <ResearchDetail key={instrumentId} instrumentId={instrumentId} />;
}

function ResearchDetail({ instrumentId }: { instrumentId?: string }) {
  const cache = useQueryClient();
  const [notice, setNotice] = useState("");
  const instrument = useQuery({
    queryKey: ["instrument", instrumentId], enabled: !!instrumentId,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/instruments/{instrument_id}", { signal, params: { path: { instrument_id: instrumentId! } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const quote = useQuery({
    queryKey: ["quote", instrumentId], enabled: !!instrument.data,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/instruments/{instrument_id}/quotes", { signal, params: { path: { instrument_id: instrumentId! } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const watch = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = enabled
        ? await api.POST("/api/v1/watchlists", { body: { instrumentId: instrumentId! } })
        : await api.DELETE("/api/v1/watchlists/{instrument_id}", { params: { path: { instrument_id: instrumentId! } } });
      if (!result.response.ok) throw new Error(errorMessage(result.error));
      setNotice(enabled ? "已加入关注" : "已移出关注");
      await cache.invalidateQueries({ queryKey: ["instruments"] });
    },
  });
  if (!instrumentId) return <><header className="workspace-header"><h1>股票研究</h1></header><Empty title="从一只股票开始研究">前往市场搜索名称或代码，打开股票资料。</Empty><p className="center-link"><Link to="/market">查找股票 →</Link></p></>;
  return <><header className="workspace-header"><h1>{instrument.data?.name || "股票研究"}</h1><Link to="/market"><ArrowLeft size={14} /> 返回市场</Link></header>
    <div className="workspace-content">
      {instrument.isPending ? <p role="status">正在读取股票资料…</p> : instrument.isError ? <div role="alert"><p>{errorMessage(instrument.error)}</p><Button onClick={() => instrument.refetch()}>重新读取</Button></div> : <>
        <div className="research-heading"><div><h2>{instrument.data.name} <span className="secondary">{instrument.data.code}</span></h2><p className="secondary">{boardNames[instrument.data.board]} · {instrument.data.isCurrent ? "当前目录已收录" : "已不在最新目录，上市状态待核验"}</p></div>
          <div className="control-group"><Button disabled={watch.isPending} onClick={() => watch.mutate(true)}><Star size={16} />加入关注</Button><Button disabled={watch.isPending} onClick={() => watch.mutate(false)}>移出关注</Button></div>
        </div>
        {notice && <p role="status" className="save-notice">{notice}</p>}
        {watch.isError && <p role="alert" className="error">{errorMessage(watch.error)}</p>}
        <section className="ledger-section"><h2>行情快照</h2>
          {quote.isPending ? <p role="status">正在读取最新可用报价…</p> : quote.isError ? <div role="alert"><p>{errorMessage(quote.error)}</p><Button onClick={() => quote.refetch()}>重新获取报价</Button></div> : quote.data && <>
            <div className="quote-strip">
              {[["最新价", quote.data.price], ["前收盘", quote.data.previousClose], ["开盘", quote.data.open], ["最高", quote.data.high], ["最低", quote.data.low]].map(([label, value]) => <div key={label}><span className="secondary">{label}（元）</span><strong>{value ?? "暂缺"}</strong></div>)}
            </div>
            <p className="source-note">{quote.data.source} · 行情时间 {new Date(quote.data.quotedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {quote.data.freshness === "STALE" ? "报价已过期，仅供研究" : "近期报价，仅供研究"}</p>
            <Button disabled={quote.isFetching} onClick={() => quote.refetch()}>{quote.isFetching ? "正在刷新…" : "刷新报价"}</Button>
          </>}
        </section>
        <EvidenceResearch instrumentId={instrumentId} />
      </>}
    </div>
  </>;
}
