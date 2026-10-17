import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "@koolezt/domain";
import type { CreativeDnaPreprocessor, GeneratedAsset, StorageProvider } from "@koolezt/domain";
/* eslint-disable @typescript-eslint/no-explicit-any */

export const MAX_CREATIVE_DNA_FRAMES = 12;
export function creativeDnaSampleTimestamps(durationMs:number,maxFrames=MAX_CREATIVE_DNA_FRAMES):readonly number[]{
  if(!Number.isFinite(durationMs)||durationMs<=0)throw new DomainError("CREATIVE_DNA_MEDIA_INVALID","Creative DNA analysis requires a positive video duration.");
  const end=Math.max(0,durationMs-100);const dense=[0,250,500,1000,1500,2000,3000].filter(x=>x<=end);const remaining=Math.max(0,maxFrames-dense.length-1);const periodic=Array.from({length:remaining},(_,i)=>Math.round(3000+(end-3000)*(i+1)/(remaining+1))).filter(x=>x>3000&&x<end);
  return [...new Set([...dense,...periodic,end])].sort((a,b)=>a-b).slice(0,maxFrames);
}
function run(command:string,args:readonly string[]):Promise<Buffer>{return new Promise((resolve,reject)=>{const child=spawn(command,[...args],{stdio:["ignore","pipe","pipe"],windowsHide:true});const out:Buffer[]=[];const err:Buffer[]=[];child.stdout.on("data",x=>out.push(Buffer.from(x)));child.stderr.on("data",x=>err.push(Buffer.from(x)));child.on("error",()=>reject(new DomainError("CREATIVE_DNA_MEDIA_TOOL_UNAVAILABLE","FFmpeg/ffprobe is unavailable.")));child.on("close",code=>code===0?resolve(Buffer.concat(out)):reject(new DomainError("CREATIVE_DNA_MEDIA_INVALID",Buffer.concat(err).toString("utf8").slice(0,500)||"Media preprocessing failed.")));});}
export class FfmpegCreativeDnaPreprocessor implements CreativeDnaPreprocessor{
  constructor(private readonly storage:StorageProvider,private readonly ffmpegPath=process.env.FFMPEG_PATH??"ffmpeg",private readonly ffprobePath=process.env.FFPROBE_PATH??"ffprobe"){}
  // The parsed rational is guarded by its denominator before division.
  // @ts-expect-error noUncheckedIndexedAccess cannot infer that guard on this compact parser.
  async preprocess(asset:GeneratedAsset){if(asset.kind!=="VIDEO")throw new DomainError("CREATIVE_DNA_VIDEO_REQUIRED","Creative DNA analysis requires a video asset.");const root=await mkdtemp(join(tmpdir(),"koolezt-dna-"));try{const input=join(root,`source-${randomUUID()}.video`);await writeFile(input,await this.storage.read(asset.storageKey),{mode:0o600});const raw=await run(this.ffprobePath,["-v","error","-show_streams","-show_format","-of","json",input]);const probe=JSON.parse(raw.toString("utf8")) as any;const video=probe.streams?.find((s:any)=>s.codec_type==="video");if(!video)throw new DomainError("CREATIVE_DNA_MEDIA_INVALID","Historical creative has no video stream.");const durationMs=Math.round(Number(probe.format?.duration??video.duration)*1000);const rate=String(video.avg_frame_rate??"0/1").split("/").map(Number);const frameRate=rate[1]?rate[0]/rate[1]:undefined;const mediaMetadata={durationMs,width:Number(video.width),height:Number(video.height),...(frameRate&&Number.isFinite(frameRate)?{frameRate}:{}),hasAudio:Boolean(probe.streams?.some((s:any)=>s.codec_type==="audio")),mimeType:asset.mimeType};const frames=[];for(const timestampMs of creativeDnaSampleTimestamps(durationMs)){const output=join(root,`frame-${timestampMs}.jpg`);await run(this.ffmpegPath,["-hide_banner","-loglevel","error","-ss",(timestampMs/1000).toFixed(3),"-i",input,"-frames:v","1","-vf","scale='min(768,iw)':-2","-q:v","3","-y",output]);const bytes=await readFile(output);frames.push({timestampMs,mimeType:"image/jpeg" as const,bytesBase64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")});}return{mediaMetadata,frames};}finally{await rm(root,{recursive:true,force:true});}}
}
