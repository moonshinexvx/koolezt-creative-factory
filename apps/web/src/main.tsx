import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { ProductsPage } from "./products.js";
import { VideosPage } from "./videos.js";
import { WinnerAnalysis } from "./winners.js";
import "./style.css";
import "./make-videos.css";

type Page = "WINNERS" | "PRODUCTS" | "VIDEOS";
const paths: Record<Page, string> = { WINNERS: "/winners", PRODUCTS: "/products", VIDEOS: "/videos" };
const pageFromLocation = (): Page => (window.location.pathname.startsWith("/products") ? "PRODUCTS" : window.location.pathname.startsWith("/videos") ? "VIDEOS" : "WINNERS");

/** Winner-to-video app: analyze a winning ad, then make new videos from it. */
function App() {
  const [page, setPage] = useState<Page>(pageFromLocation);
  const [products, setProducts] = useState<any[]>([]);
  const [session, setSession] = useState<{ email?: string; role?: string }>({});
  const [error, setError] = useState("");
  const loadProducts = useCallback(async () => setProducts(await api("/api/products")), []);
  useEffect(() => {
    void Promise.all([api("/api/session").then(setSession), loadProducts()]).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load the app."));
    const onBack = () => setPage(pageFromLocation());
    window.addEventListener("popstate", onBack);
    return () => window.removeEventListener("popstate", onBack);
  }, [loadProducts]);
  const go = (next: Page) => { setPage(next); history.pushState({}, "", paths[next]); };
  const navButton = (target: Page, label: string) => <button className={page === target ? "nav-active" : ""} onClick={() => go(target)}>{label}</button>;
  const sidebar = <aside className="global-sidebar"><div><h1>Koolezt<br />Creative Factory</h1>
    <nav aria-label="Main navigation">{navButton("WINNERS", "Winners")}{navButton("PRODUCTS", "Products")}{navButton("VIDEOS", "All videos")}</nav>
    {error && <p className="error small">{error}</p>}</div>
    <div className="session-identity"><b>{session.email || "Private session"}</b><span>{session.role}</span><small>Sign out through Cloudflare Access.</small></div></aside>;
  if (page === "PRODUCTS") return <ProductsPage sidebar={sidebar} products={products} onChanged={loadProducts} />;
  if (page === "VIDEOS") return <VideosPage sidebar={sidebar} products={products} />;
  return <WinnerAnalysis sidebar={sidebar} products={products} isOwner={session.role === "OWNER" || session.role === "DEVELOPMENT"} />;
}

createRoot(document.getElementById("root")!).render(<App />);
