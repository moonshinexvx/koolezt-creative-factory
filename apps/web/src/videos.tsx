import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api.js";

/** Every video made from any winner, newest first. */
export function VideosPage({ sidebar, products }: Readonly<{ sidebar: ReactNode; products: readonly any[] }>) {
  const [batches, setBatches] = useState<any[]>([]);
  const [winners, setWinners] = useState<any[]>([]);
  const [productFilter, setProductFilter] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([api("/api/video-batches"), api("/api/creative-references")]).then(([nextBatches, nextWinners]) => { setBatches(nextBatches); setWinners(nextWinners); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load videos."));
  }, []);
  const winnerName = useMemo(() => new Map(winners.map((entry: any) => [entry.reference.id, entry.reference.displayName])), [winners]);
  const productName = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);
  const videos = batches.filter(({ batch }) => !productFilter || batch.productId === productFilter)
    .flatMap(({ batch, videos: items }) => items.filter((video: any) => video.status === "READY").map((video: any) => ({ video, batch })))
    .sort((a, b) => String(b.video.updatedAt).localeCompare(String(a.video.updatedAt)));

  return <main className="app-shell">{sidebar}<aside className="project-browser winner-library">
    <div className="project-browser-header"><h2>All videos</h2></div>
    <select value={productFilter} onChange={(event) => setProductFilter(event.target.value)} aria-label="Filter by product"><option value="">All products</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>
    <p className="muted small">{videos.length} finished video{videos.length === 1 ? "" : "s"}. Open a winner to write and make more.</p>
  </aside><section className="workspace workspace-static winner-workspace"><div className="workspace-panel">
    {error && <p className="error" role="alert">{error}</p>}
    {videos.length === 0 ? <section className="card"><h2>No videos yet</h2><p>Open a winner, write video plans, tick the ones you like and click "Make selected videos".</p></section>
      : <div className="video-library">{videos.map(({ video, batch }) => <article className="card video-tile" key={video.id}>
        <video controls preload="metadata" src={`/api/assets/${video.outputAssetId}`} />
        <h4>{video.plan.title}</h4>
        <p className="muted small">From winner "{winnerName.get(batch.creativeReferenceId) ?? "Unknown"}" · {productName.get(batch.productId) ?? "Unknown product"} · {Math.round((video.durationMs ?? 0) / 1000)}s</p>
        <p className="small">{video.plan.changes}</p>
        <a className="button primary" href={`/api/videos/${video.id}/download`}>Download MP4</a>
      </article>)}</div>}
  </div></section></main>;
}
