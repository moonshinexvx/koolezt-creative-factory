import { describe, expect, it, vi } from "vitest";
import { DomainError } from "@koolezt/domain";
import { buildServer } from "../apps/api/src/server.js";

const product = { id: "44444444-4444-4444-8444-444444444444", name: "Dog Address Sign" };
const asset = {
  id: "22222222-2222-4222-8222-222222222222", kind: "VIDEO", purpose: "WINNER_SOURCE_VIDEO",
  storageKey: "creative-factory/working/44444444-4444-4444-8444-444444444444/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.mp4",
  mimeType: "video/mp4", byteSize: 16, sha256: "a".repeat(64), lifecycleStatus: "AVAILABLE", metadata: { originalFilename: "winner.mp4" }, createdAt: new Date().toISOString()
};

function multipart(filename?: string, mimeType = "video/mp4", bytes = Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisomfixture")])) {
  const boundary = "----koolezt-creative-reference-test";
  const chunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="displayName"\r\n\r\nHistorical winner\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="operatorStatus"\r\n\r\nWINNER\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="platform"\r\n\r\nMeta / Facebook\r\n`)
  ];
  if(filename) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),bytes,Buffer.from("\r\n"));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

function runtime(overrides: Record<string,unknown> = {}) {
  const put = vi.fn(async (_key:string,input:{mimeType:string;metadata:Readonly<Record<string,unknown>>})=>({...asset,mimeType:input.mimeType,metadata:input.metadata}));
  const createUpload = vi.fn(async (input:{mimeType:string;originalFilename?:string})=>({asset:{...asset,mimeType:input.mimeType,metadata:{originalFilename:input.originalFilename}},method:"PUT",url:"https://uploads.example.test/winner",headers:{"content-type":input.mimeType},expiresAt:new Date(Date.now()+60_000).toISOString()}));
  const completeUpload = vi.fn(async()=>asset);
  const register = vi.fn(async (input:{assetId:string;displayName:string;operatorStatus:string;platform?:string})=>({id:"reference-1",sourceAssetId:input.assetId,displayName:input.displayName,operatorStatus:input.operatorStatus,platform:input.platform,analysisStatus:"NOT_ANALYZED"}));
  const requestAnalysis = vi.fn();
  const deleteAsset = vi.fn(async()=>undefined);
  const list = vi.fn(async ():Promise<unknown[]>=>[]);
    return {
    service:{getProduct:vi.fn(async()=>product),listProducts:vi.fn(async()=>[product])},storage:{put,getAsset:vi.fn(async()=>asset),read:vi.fn(async()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisomfixture")]))},
    creativeDnaService:{register,requestAnalysis,list,listWinnerReports:vi.fn(async()=>[]),listMetaLinks:vi.fn(async()=>[])},durableMediaStore:{createUpload,completeUpload,deleteAsset,rejectUpload:vi.fn(async()=>undefined)},
    ...overrides,
    spies:{put,createUpload,completeUpload,register,requestAnalysis,deleteAsset,list}
  };
}

describe("Creative Reference source-video upload API",()=>{
  it("authorizes direct durable upload and registers only after verified completion",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const authorization=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/upload`,payload:{filename:"winner.mp4",mimeType:"video/mp4",byteSize:asset.byteSize,sha256:asset.sha256}});
    expect(authorization.statusCode).toBe(200);
    expect(authorization.json()).toMatchObject({assetId:asset.id,method:"PUT",url:"https://uploads.example.test/winner"});
    expect(setup.spies.createUpload).toHaveBeenCalledWith(expect.objectContaining({projectId:product.id,purpose:"WINNER_SOURCE_VIDEO",kind:"VIDEO",originalFilename:"winner.mp4"}));
    expect(setup.spies.register).not.toHaveBeenCalled();
    const completion=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/complete`,payload:{assetId:asset.id,displayName:"Historical winner",operatorStatus:"WINNER",platform:"Meta / Facebook"}});
    expect(completion.statusCode).toBe(200);
    expect(setup.spies.completeUpload).toHaveBeenCalledWith(asset.id);
    expect(setup.spies.register).toHaveBeenCalledWith(expect.objectContaining({assetId:asset.id,displayName:"Historical winner",operatorStatus:"WINNER"}));
    expect(setup.spies.requestAnalysis).not.toHaveBeenCalled();
    await app.close();
  });

  it("files an uploaded winner under its Product and lists it with its report",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const completion=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/complete`,payload:{assetId:asset.id,displayName:"Library winner",operatorStatus:"WINNER"}});
    expect(completion.statusCode).toBe(200);
    expect(setup.spies.register).toHaveBeenCalledWith(expect.objectContaining({productId:product.id,assetId:asset.id}));
    setup.creativeDnaService.list=vi.fn(async()=>[{reference:{id:"reference-1",sourceAssetId:asset.id,productId:product.id},revisions:[]}]);
    setup.creativeDnaService.listWinnerReports=vi.fn(async()=>[{creativeReferenceId:"reference-1",status:"READY",providerMetadata:{},createdAt:"t",updatedAt:"t"}]) as never;
    const listed=await app.inject({method:"GET",url:"/api/creative-references"});
    expect(listed.json()[0]).toMatchObject({productName:"Dog Address Sign",winnerReport:{status:"READY"}});
    await app.close();
  });

  it("reports the Meta integration as not configured instead of failing",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const status=await app.inject({method:"GET",url:"/api/meta/status"});
    expect(status.json()).toEqual({configured:false});
    const top=await app.inject({method:"GET",url:"/api/meta/top-ads?accountId=act_123456&since=2026-09-01&until=2026-10-26"});
    expect(top.json().error).toBe("META_NOT_CONFIGURED");
    await app.close();
  });

  it("links a manually uploaded winner to its Meta ad after registration",async()=>{
    const linkUploaded=vi.fn(async()=>undefined);
    const setup=runtime({metaWinners:{linkUploaded}});const app=buildServer(setup as never);
    const completion=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/complete`,payload:{assetId:asset.id,displayName:"Meta winner",operatorStatus:"WINNER",metaAccountId:"123456",metaAdId:"120200000000000001"}});
    expect(completion.statusCode).toBe(200);
    expect(setup.spies.register).toHaveBeenCalledWith(expect.not.objectContaining({metaAdId:expect.anything()}));
    expect(linkUploaded).toHaveBeenCalledWith("reference-1","act_123456","120200000000000001");
    await app.close();
  });

  it("lets the owner delete a winner",async()=>{
    const archive=vi.fn(async()=>undefined);
    const setup=runtime();(setup.creativeDnaService as Record<string,unknown>).archive=archive;const app=buildServer(setup as never);
    const response=await app.inject({method:"DELETE",url:"/api/creative-references/reference-1"});
    expect(response.statusCode).toBe(200);
    expect(archive).toHaveBeenCalledWith("reference-1",expect.any(String));
    await app.close();
  });

  it("starts a report-only regeneration when requested",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const requestId=crypto.randomUUID();
    const response=await app.inject({method:"POST",url:"/api/creative-references/reference-1/analyze",payload:{requestId,mode:"REPORT"}});
    expect(response.statusCode).toBe(202);
    expect(setup.spies.requestAnalysis).toHaveBeenCalledWith("reference-1",requestId,"REPORT");
    await app.close();
  });

  it("rejects unsupported direct uploads before creating a durable asset",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const response=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/upload`,payload:{filename:"winner.mov",mimeType:"video/mp4",byteSize:asset.byteSize,sha256:asset.sha256}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(setup.spies.createUpload).not.toHaveBeenCalled();
    await app.close();
  });

  it("deletes a completed direct asset if Creative Reference registration fails",async()=>{
    const setup=runtime();
    setup.creativeDnaService.register=vi.fn(async()=>{throw new DomainError("CREATIVE_REFERENCE_WRITE_FAILED","Reference write failed.");});
    const app=buildServer(setup as never);
    const response=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/complete`,payload:{assetId:asset.id,displayName:"Historical winner",operatorStatus:"WINNER"}});
    expect(response.statusCode).toBe(409);
    expect(setup.spies.deleteAsset).toHaveBeenCalledWith(asset.id);
    expect(setup.spies.requestAnalysis).not.toHaveBeenCalled();
    await app.close();
  });

  it("never deletes a durable asset that belongs to another product",async()=>{
    const setup=runtime();
    setup.durableMediaStore.completeUpload=vi.fn(async()=>({...asset,storageKey:asset.storageKey.replace(product.id,"99999999-9999-4999-8999-999999999999")}));
    const app=buildServer(setup as never);
    const response=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references/complete`,payload:{assetId:asset.id,displayName:"Historical winner",operatorStatus:"WINNER"}});
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("DURABLE_MEDIA_SCOPE_MISMATCH");
    expect(setup.spies.deleteAsset).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["winner.mp4","video/mp4",Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisomfixture")])],
    ["winner.webm","video/webm",Buffer.from([0x1a,0x45,0xdf,0xa3,0,0,0,0])]
  ])("accepts and links %s without starting DNA analysis",async(filename,mimeType,bytes)=>{
    const setup=runtime();const app=buildServer(setup as never);
    const response=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references`,...multipart(filename,mimeType,bytes)});
    expect(response.statusCode).toBe(200);
    expect(setup.spies.put).toHaveBeenCalledWith(expect.stringContaining(`products/${product.id}/winners/`),expect.objectContaining({mimeType,metadata:expect.objectContaining({purpose:"WINNER_SOURCE_VIDEO",originalFilename:filename})}));
    expect(setup.spies.register).toHaveBeenCalledWith(expect.objectContaining({assetId:asset.id,operatorStatus:"WINNER"}));
    expect(setup.spies.requestAnalysis).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a missing source file and an unsupported extension before durable storage",async()=>{
    const setup=runtime();const app=buildServer(setup as never);
    const missing=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references`,...multipart()});
    const unsupported=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references`,...multipart("winner.mov")});
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toBe("UPLOAD_REQUIRED");
    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.json().error).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(setup.spies.put).not.toHaveBeenCalled();
    expect(setup.spies.register).not.toHaveBeenCalled();
    await app.close();
  });

  it("quarantines an uploaded durable asset when reference registration fails",async()=>{
    const setup=runtime();
    setup.creativeDnaService.register=vi.fn(async()=>{throw new DomainError("CREATIVE_REFERENCE_WRITE_FAILED","Reference write failed.");});
    const app=buildServer(setup as never);
    const response=await app.inject({method:"POST",url:`/api/products/${product.id}/creative-references`,...multipart("winner.mp4")});
    expect(response.statusCode).toBe(409);
    expect(setup.spies.put).toHaveBeenCalledOnce();
    expect(setup.spies.deleteAsset).toHaveBeenCalledWith(asset.id);
    expect(setup.spies.requestAnalysis).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns safe source filename and availability metadata for a registered reference",async()=>{
    const setup=runtime();
    setup.creativeDnaService.list=vi.fn(async()=>[{reference:{id:"reference-1",sourceAssetId:asset.id},revisions:[]}]);
    const app=buildServer(setup as never);
    const response=await app.inject({method:"GET",url:"/api/creative-references"});
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].sourceMedia).toEqual({filename:"winner.mp4",status:"AVAILABLE",mimeType:"video/mp4",byteSize:16});
    await app.close();
  });

});
