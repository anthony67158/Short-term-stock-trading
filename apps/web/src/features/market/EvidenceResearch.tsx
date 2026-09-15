import { useEffect, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import type { components } from "../../../../../packages/api-client/schema";
import { api, errorMessage } from "../../lib/api";
import { Button, Input } from "../../components/Controls";

type EvidenceInput = components["schemas"]["EvidenceInput"];
const thesisLabels = { SUPPORTED: "论点得到支持", WEAKENED: "论点减弱", INVALIDATED: "论点失效", UNCERTAIN: "证据不足" };
const claimLabels = { OBSERVED: "原文事实", INFERRED: "研究推断", HYPOTHESIS: "待验证假设" };

function EvidenceForm({ instrumentId, done }: { instrumentId: string; done: () => void }) {
  const command = useRef({ body: "", key: "" });
  const save = useMutation({
    mutationFn: async (body: EvidenceInput) => {
      const serialized = JSON.stringify(body);
      if (command.current.body !== serialized) command.current = { body: serialized, key: crypto.randomUUID() };
      const result = await api.POST("/api/v1/evidence", { body, params: { header: { "Idempotency-Key": command.current.key } } });
      if (!result.data) throw new Error(errorMessage(result.error));
    }, onSuccess: done,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      instrumentId, title: String(data.get("title")), sourceUrl: String(data.get("url")),
      publishedAt: new Date(String(data.get("published"))).toISOString(),
      text: String(data.get("text")), quote: String(data.get("quote")),
    });
  }
  return <form className="inline-form evidence-form" onSubmit={submit}>
    <Input id="evidence-title" label="材料标题" name="title" maxLength={200} required autoFocus />
    <Input id="evidence-url" label="原文链接（HTTPS）" name="url" type="url" required />
    <Input id="evidence-published" label="原文发布时间" name="published" type="datetime-local" required />
    <label className="field wide-field"><span>原文内容</span><textarea name="text" minLength={20} maxLength={20000} required /></label>
    <label className="field wide-field"><span>引用片段（须与原文一致）</span><textarea name="quote" minLength={10} maxLength={3000} required /></label>
    <p className="secondary wide-field">手动提交的材料标记为“用户提供”，片段校验不代表来源真实性已核验。原文修订请保存为新材料。</p>
    <div className="form-actions"><Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "正在保存…" : "保存材料"}</Button><Button type="button" onClick={done}>关闭</Button></div>
    {save.isError && <p role="alert" className="error">{errorMessage(save.error)}</p>}
  </form>;
}

export function EvidenceResearch({ instrumentId }: { instrumentId: string }) {
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [question, setQuestion] = useState("这只股票的投资论点、最强反证与下次验证节点是什么？");
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("researchJob");
  const command = useRef({ body: "", key: "" });
  const capability = useQuery({
    queryKey: ["research-capability"],
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/research-capability", { signal });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
  });
  const evidence = useInfiniteQuery({
    queryKey: ["evidence", instrumentId], initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const result = await api.GET("/api/v1/instruments/{instrument_id}/evidence", { signal, params: { path: { instrument_id: instrumentId }, query: { cursor: pageParam } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const research = useInfiniteQuery({
    queryKey: ["research", instrumentId], initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) => {
      const result = await api.GET("/api/v1/instruments/{instrument_id}/research", { signal, params: { path: { instrument_id: instrumentId }, query: { cursor: pageParam } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const job = useQuery({
    queryKey: ["job", jobId], enabled: !!jobId,
    queryFn: async ({ signal }) => {
      const result = await api.GET("/api/v1/jobs/{job_id}", { signal, params: { path: { job_id: jobId! } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      return result.data.data;
    },
    refetchInterval: (query) => ["QUEUED", "RUNNING"].includes(query.state.data?.status ?? "") ? 1000 : false,
  });
  useEffect(() => {
    if (job.data?.status === "SUCCEEDED") void cache.invalidateQueries({ queryKey: ["research", instrumentId] });
  }, [job.data?.status, cache, instrumentId]);
  const start = useMutation({
    mutationFn: async () => {
      const body = { instrumentId, question, evidenceIds: selected };
      const serialized = JSON.stringify(body);
      if (command.current.body !== serialized) command.current = { body: serialized, key: crypto.randomUUID() };
      const result = await api.POST("/api/v1/research-runs", { body, params: { header: { "Idempotency-Key": command.current.key } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      setSearchParams({ researchJob: result.data.data.id }, { replace: true });
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const result = await api.POST("/api/v1/jobs/{job_id}/cancellations", { params: { path: { job_id: jobId! } } });
      if (!result.data) throw new Error(errorMessage(result.error));
      await job.refetch();
    },
  });
  const items = evidence.data?.pages.flatMap((page) => page.evidence) ?? [];
  const assessments = research.data?.pages.flatMap((page) => page.assessments) ?? [];
  const running = ["QUEUED", "RUNNING"].includes(job.data?.status ?? "");
  return <section className="ledger-section">
    <div className="section-toolbar"><h2>投资论点与证据</h2><Button onClick={() => setAdding(true)}>添加研究材料</Button></div>
    {adding && <EvidenceForm instrumentId={instrumentId} done={async () => { setAdding(false); await evidence.refetch(); }} />}
    <p className="source-note">{capability.data?.reason || (capability.isError ? "无法读取研究服务状态" : "研究产物仅供研究；联合预测尚未上线。")}</p>
    {evidence.isError ? <div role="alert"><p>{errorMessage(evidence.error)}</p><Button onClick={() => evidence.refetch()}>重新读取材料</Button></div> : evidence.isPending ? <p role="status">正在读取研究材料…</p> : items.length === 0 ? <p className="secondary">尚无材料。添加有出处的原文，建立可追溯的研究依据。</p> : items.map((item) =>
      <details className="evidence-item" key={item.id}><summary>{item.title} <span className="secondary">· 用户提供 · 片段已匹配</span></summary>
        <label className="check-field"><input type="checkbox" checked={selected.includes(item.id)} disabled={!selected.includes(item.id) && selected.length >= 16} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />用于本次研究</label>
        <blockquote>{item.quote}</blockquote><p className="source-note"><a href={item.sourceUrl} target="_blank" rel="noreferrer">查看来源</a> · 发布于 {new Date(item.publishedAt).toLocaleString("zh-CN")}</p>
        <pre className="evidence-text">{item.text}</pre>
      </details>)}
    {evidence.hasNextPage && <Button onClick={() => evidence.fetchNextPage()} disabled={evidence.isFetchingNextPage}>更多材料</Button>}
    <form className="research-question" onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
      <Input id="research-question" label={`研究问题 · 已选 ${selected.length} 份材料`} value={question} onChange={(event) => setQuestion(event.target.value)} minLength={5} maxLength={1000} required />
      <Button type="submit" variant="primary" disabled={!capability.data?.available || !selected.length || running || start.isPending}>{start.isPending ? "提交研究…" : "开始证据研究"}</Button>
    </form>
    {[start.error, cancel.error, job.error].filter(Boolean).map((error, index) => <p key={index} role="alert" className="error">{errorMessage(error)}</p>)}
    {job.data && <div className="task-status" role="status"><span>{job.data.stage}{job.data.message ? `：${job.data.message}` : ""}</span>{running && <Button disabled={cancel.isPending || job.data.cancellationRequested} onClick={() => cancel.mutate()}>{job.data.cancellationRequested ? "已请求停止" : "停止研究"}</Button>}</div>}
    {research.isError && <div role="alert"><p>{errorMessage(research.error)}</p><Button onClick={() => research.refetch()}>重新读取研判</Button></div>}
    {assessments.map((assessment) => <article className="assessment" key={assessment.id}>
      <h3>{thesisLabels[assessment.output.thesisStatus]} · 研究论点</h3><p>{assessment.output.summary}</p>
      <p className="source-note">引用校验通过 · 不代表推断已证实 · {new Date(assessment.createdAt).toLocaleString("zh-CN")}</p>
      {[...assessment.output.claims, ...assessment.output.counterClaims].map((claim, index) => <p key={index}><strong>{claimLabels[claim.kind]}：</strong>{claim.statement} <span className="secondary">引用 {claim.evidenceIds.map((id) => items.find((item) => item.id === id)?.title || "材料详情待加载").join("、")}</span></p>)}
      <p><strong>失效条件：</strong>{assessment.output.invalidation}</p><p><strong>下次验证：</strong>{assessment.output.nextCheck}</p>
      <p><strong>待补证据：</strong>{assessment.output.uncertainties.join("；")}</p>
    </article>)}
    {research.hasNextPage && <Button onClick={() => research.fetchNextPage()} disabled={research.isFetchingNextPage}>更多研判版本</Button>}
  </section>;
}
