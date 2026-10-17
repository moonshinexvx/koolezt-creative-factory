import { describe, expect, it } from "vitest";
import { productInput } from "@koolezt/contracts";

const base={
  name:"Personalized Sign",
  slug:"personalized-sign",
  description:"A personalized sign",
  claims:[],
  defaultCta:"Create yours",
  assets:[]
};

describe("Product personalization visual-authority contract",()=>{
  it("keeps the authority optional for non-personalized and legacy Products",()=>{
    expect(productInput.parse(base)).not.toHaveProperty("personalizationVisualAuthority");
  });
  it("accepts only explicit operator-confirmed immutable and mutable fields",()=>{
    const parsed=productInput.parse({...base,personalizationVisualAuthority:{
      status:"OPERATOR_CONFIRMED",
      immutableStructure:["Silhouette","Mounting configuration"],
      authorizedPersonalizationFields:["Pet artwork","House number"],
      authorizedProductConfigurations:["Wall-mounted","Garden-stake mounted"]
    }});
    expect(parsed.personalizationVisualAuthority).toMatchObject({
      status:"OPERATOR_CONFIRMED",
      immutableStructure:["Silhouette","Mounting configuration"],
      authorizedPersonalizationFields:["Pet artwork","House number"],
      authorizedProductConfigurations:["Wall-mounted","Garden-stake mounted"]
    });
  });
  it("rejects inferred, empty, or duplicate permissions",()=>{
    expect(()=>productInput.parse({...base,personalizationVisualAuthority:{status:"DRAFT",immutableStructure:["Silhouette"],authorizedPersonalizationFields:["Number"]}})).toThrow();
    expect(()=>productInput.parse({...base,personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED",immutableStructure:[],authorizedPersonalizationFields:["Number"]}})).toThrow();
    expect(()=>productInput.parse({...base,personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED",immutableStructure:["Silhouette"],authorizedPersonalizationFields:["Number","Number"]}})).toThrow();
    expect(()=>productInput.parse({...base,personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED",immutableStructure:["Silhouette"],authorizedPersonalizationFields:["Number"],authorizedProductConfigurations:["Garden stake","Garden stake"]}})).toThrow();
    expect(()=>productInput.parse({...base,personalizationVisualAuthority:{status:"OPERATOR_CONFIRMED",immutableStructure:["Silhouette","Garden-stake mounted"],authorizedPersonalizationFields:["Number"],authorizedProductConfigurations:["garden-stake mounted"]}})).toThrow();
  });
});
