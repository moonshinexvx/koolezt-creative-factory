import { useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";

type Draft = { name: string; description: string; facts: string; defaultCta: string; neverChange: string; customersCanChange: string };
const emptyDraft: Draft = { name: "", description: "", facts: "", defaultCta: "Shop now", neverChange: "", customersCanChange: "" };
const lines = (value: string) => [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
const slugify = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "product";

function draftFrom(product: any): Draft {
  const rules = product.personalizationVisualAuthority;
  return {
    name: product.name, description: product.description, facts: product.claims.map((claim: any) => claim.text).join("\n"), defaultCta: product.defaultCta,
    neverChange: (rules?.immutableStructure ?? []).join("\n"), customersCanChange: (rules?.authorizedPersonalizationFields ?? []).join("\n")
  };
}

/** Builds the product API body; existing claim kinds and photos are kept, look rules are saved only when both lists are filled. */
function productBody(draft: Draft, existing?: any, assets?: readonly any[]) {
  const previousKind = new Map((existing?.claims ?? []).map((claim: any) => [claim.text, claim.kind]));
  const neverChange = lines(draft.neverChange);
  const customersCanChange = lines(draft.customersCanChange);
  return {
    name: draft.name.trim(), slug: existing?.slug ?? `${slugify(draft.name)}-${Date.now().toString(36)}`, description: draft.description.trim(),
    claims: lines(draft.facts).map((text) => ({ kind: previousKind.get(text) ?? "FEATURE", text })), defaultCta: draft.defaultCta.trim() || "Shop now",
    ...(existing?.creativeNotes ? { creativeNotes: existing.creativeNotes } : {}),
    ...(neverChange.length && customersCanChange.length ? { personalizationVisualAuthority: { status: "OPERATOR_CONFIRMED", immutableStructure: neverChange, authorizedPersonalizationFields: customersCanChange, ...(existing?.personalizationVisualAuthority?.authorizedProductConfigurations ? { authorizedProductConfigurations: existing.personalizationVisualAuthority.authorizedProductConfigurations } : {}) } } : {}),
    assets: (assets ?? existing?.assets ?? []).map((asset: any) => ({ id: asset.id, kind: asset.kind, label: asset.label, storageKey: asset.storageKey, mimeType: asset.mimeType }))
  };
}

export function ProductsPage({ sidebar, products, onChanged }: Readonly<{ sidebar: ReactNode; products: readonly any[]; onChanged: () => Promise<void> }>) {
  const [selectedId, setSelectedId] = useState<string | undefined>(products[0]?.id);
  const [creating, setCreating] = useState(products.length === 0);
  const [draft, setDraft] = useState<Draft>(() => (products[0] ? draftFrom(products[0]) : emptyDraft));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const selected = creating ? undefined : products.find((product) => product.id === selectedId);
  const open = (product: any) => { setCreating(false); setSelectedId(product.id); setDraft(draftFrom(product)); setError(""); setNotice(""); };
  const run = async (action: () => Promise<void>, failure: string) => {
    setWorking(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : failure); } finally { setWorking(false); }
  };
  const save = () => run(async () => {
    if (!draft.name.trim() || !draft.description.trim()) throw new Error("Give the product a name and a short description.");
    if (selected) await api(`/api/products/${selected.id}`, "PUT", productBody(draft, selected));
    else { const created = await api("/api/products", "POST", productBody(draft)); setSelectedId(created.id); setCreating(false); }
    await onChanged();
    setNotice("Saved.");
  }, "Could not save the product.");
  const uploadPhotos = (files: FileList | null) => run(async () => {
    if (!selected || !files?.length) return;
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/products/${selected.id}/assets`, { method: "POST", headers: { "x-koolezt-actor": "web-user" }, body: form });
      const json = await response.json();
      if (!response.ok) throw new Error(json.message ?? `Could not upload ${file.name}.`);
    }
    if (fileInput.current) fileInput.current.value = "";
    await onChanged();
  }, "Could not upload the photos.");
  const updateAssets = (assets: readonly any[]) => run(async () => { await api(`/api/products/${selected.id}`, "PUT", productBody(draftFrom(selected), selected, assets)); await onChanged(); }, "Could not update the photos.");
  const field = (key: keyof Draft, label: string, rows = 0, hint = "") => <label>{label}{hint && <small className="muted">{hint}</small>}{rows ? <textarea rows={rows} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /> : <input value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />}</label>;
  const photos = (selected?.assets ?? []).filter((asset: any) => asset.kind === "IMAGE");

  const list = <aside className="project-browser winner-library">
    <div className="project-browser-header"><h2>Products</h2><button className="primary" onClick={() => { setCreating(true); setDraft(emptyDraft); setError(""); setNotice(""); }}>+ Add product</button></div>
    <div className="winner-list">{products.map((product) => <button key={product.id} className={`winner-card ${!creating && selected?.id === product.id ? "active" : ""}`} onClick={() => open(product)}><b>{product.name}</b><span>{product.assets.filter((asset: any) => asset.kind === "IMAGE").length} photos · {product.claims.length} facts</span></button>)}
      {products.length === 0 && <p className="empty">No products yet.</p>}</div>
  </aside>;

  return <main className="app-shell">{sidebar}{list}<section className="workspace workspace-static winner-workspace"><div className="workspace-panel">
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <section className="card product-form"><h2>{selected ? selected.name : "Add a product"}</h2>
      <p className="muted">The AI only uses what you write here: facts are the only claims new videos may make, and the photos are the only images they show.</p>
      {field("name", "Product name")}
      {field("description", "Short description", 3)}
      {field("facts", "Facts the ads may say (one per line)", 6, "Only real, checkable facts. Process notes (like shipping steps) don't belong here.")}
      {field("defaultCta", "Default call to action")}
      <h4>Product look rules (optional)</h4>
      <div className="form-grid two">{field("neverChange", "Never change (one per line)", 4, "e.g. Vertical sign shape, house number in the middle")}{field("customersCanChange", "Customers can change (one per line)", 4, "e.g. Pet design, house number, street name")}</div>
      <div className="winner-actions"><button className="primary" disabled={working} onClick={() => void save()}>{working ? "Saving…" : selected ? "Save changes" : "Create product"}</button></div>
    </section>
    {selected && <section className="card"><h3>Product photos</h3>
      <p className="muted">New videos are built only from these photos. The first one is the main photo. Use clear, high-resolution images of the real product.</p>
      <div className="photo-grid">{photos.map((photo: any, index: number) => <figure key={photo.id} className={index === 0 ? "main-photo" : ""}>
        <img src={`/api/assets/${photo.id}`} alt={photo.label} />
        <figcaption>{index === 0 ? <b>Main photo</b> : <button disabled={working} onClick={() => void updateAssets([photo, ...selected.assets.filter((asset: any) => asset.id !== photo.id)])}>Make main</button>}
          <button className="danger" disabled={working} onClick={() => { if (window.confirm("Remove this photo from the product? Videos already made are not affected.")) void updateAssets(selected.assets.filter((asset: any) => asset.id !== photo.id)); }}>Remove</button></figcaption>
      </figure>)}</div>
      {photos.length === 0 && <p className="empty">No photos yet. Add at least one to make videos.</p>}
      <label className="upload-label">Add photos (PNG, JPEG or WebP)<input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={working} onChange={(event) => void uploadPhotos(event.target.files)} /></label>
    </section>}
  </div></section></main>;
}
