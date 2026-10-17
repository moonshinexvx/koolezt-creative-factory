import { DomainError } from "@koolezt/domain";
import type {
  CreativeInputSnapshot,
  ExecutionFeasibilityPlan,
  ExecutionFeasibilityRequirement
} from "@koolezt/domain";

const variationLanguage = /\b(multiple|several|gallery|carousel|variant|variation|examples?|different)\b/i;
const installedLanguage = /\b(installed|mounted|home[- ]?entry|entryway|front door|exterior wall)\b/i;
const persistentMessageLanguage = /\b(persistent|always[- ]?on|remain visible|direct[- ]?response)\b/i;

function requirement(
  value: ExecutionFeasibilityRequirement
): ExecutionFeasibilityRequirement {
  return value;
}

/** Deterministic, provider-free resolution of the authorities captured in one immutable handoff. */
export function buildExecutionFeasibilityPlan(
  input: CreativeInputSnapshot
): ExecutionFeasibilityPlan {
  const requirements: ExecutionFeasibilityRequirement[] = [];
  const imageAssets = input.selectedAssets.filter((asset) => asset.kind === "IMAGE");
  const capabilities = new Set(input.productionCapabilities ?? []);
  const winner = input.selectedWinnerDna;
  const visualAuthority = input.personalizationVisualAuthority;
  const personalizationFields =
    visualAuthority?.status === "OPERATOR_CONFIRMED"
      ? visualAuthority.authorizedPersonalizationFields.filter(Boolean)
      : [];
  const immutableStructure =
    visualAuthority?.status === "OPERATOR_CONFIRMED"
      ? visualAuthority.immutableStructure.filter(Boolean)
      : [];

  if (winner?.openingProductVisible) {
    const supported = imageAssets.length > 0 && capabilities.has("PRODUCT_IMAGE");
    requirements.push(requirement({
      code: "PRODUCT_VISIBLE_AT_OPEN",
      sourceAuthority: "WINNER_DNA",
      requirement: "Show the finished Product immediately.",
      resolution: supported ? "REQUIRED_AND_SUPPORTED" : "UNSUPPORTED_REQUIRED",
      support: supported ? ["Selected Product image and PRODUCT_IMAGE capability."] : [],
      capabilityOrAssetIds: imageAssets.map((asset) => asset.id),
      reason: supported
        ? "The authoritative Product image can appear in the opening frame."
        : "Winner DNA requires an immediate Product opening, but no authoritative Product image capability is available."
    }));
  }

  const winnerText = winner
    ? [winner.openingPattern, winner.repeatedExamplePattern, winner.directResponsePattern, ...winner.preserveTraits].join("\n")
    : "";
  if (winner && installedLanguage.test(winnerText)) {
    const supported = imageAssets.length > 0;
    requirements.push(requirement({
      code: "INSTALLED_PRODUCT_OPENING",
      sourceAuthority: "WINNER_DNA",
      requirement: "Open on the finished Product in its installed context.",
      resolution: supported ? "REQUIRED_AND_SUPPORTED" : "UNSUPPORTED_REQUIRED",
      support: supported ? ["Selected Product visual reference."] : [],
      capabilityOrAssetIds: imageAssets.map((asset) => asset.id),
      reason: supported
        ? "The opening can retain an installed Product context without changing the Product."
        : "No authoritative visual asset supports the required Product-first opening."
    }));
  }

  if (winner && persistentMessageLanguage.test(winnerText)) {
    requirements.push(requirement({
      code: "PERSISTENT_DIRECT_RESPONSE_MESSAGE",
      sourceAuthority: "WINNER_DNA",
      requirement: "Keep compliant direct-response messaging visible while examples change.",
      resolution: "REQUIRED_AND_SUPPORTED",
      support: ["Onscreen text is supported by the Creative Concept and composition pipeline."],
      capabilityOrAssetIds: [],
      reason: "Text execution can preserve the snapshot CTA without importing historical offer copy."
    }));
  }

  const variationRequired = Boolean(
    winner && ((winner.approximateExampleCount ?? 0) > 1 || variationLanguage.test(winnerText))
  );
  if (variationRequired) {
    const supported =
      personalizationFields.length > 0 &&
      imageAssets.length > 0 &&
      (capabilities.has("PRODUCT_IMAGE") || capabilities.has("PRODUCT_MOCKUP"));
    requirements.push(requirement({
      code: "AUTHORIZED_PERSONALIZATION_VARIATIONS",
      sourceAuthority: "WINNER_DNA",
      requirement: "Show multiple visibly different personalized examples while preserving one Product/SKU.",
      resolution: supported ? "REQUIRED_AND_SUPPORTED" : "UNSUPPORTED_REQUIRED",
      support: supported
        ? personalizationFields.map((field) => `Operator authorized visual variation: ${field}`)
        : [],
      capabilityOrAssetIds: imageAssets.map((asset) => asset.id),
      reason: supported
        ? "Operator-confirmed mutable fields permit repeated personalization proof without changing Product structure."
        : "Repeated variation is essential Winner DNA, but this immutable snapshot contains no operator-confirmed personalization fields."
    }));
  }

  const blocked = requirements.some((item) => item.resolution === "UNSUPPORTED_REQUIRED");
  return {
    version: 1,
    status: blocked ? "BLOCKED" : "SUPPORTED",
    requirements,
    required: requirements
      .filter((item) => item.resolution === "REQUIRED_AND_SUPPORTED")
      .map((item) => item.requirement),
    preserve: immutableStructure,
    mayVary: personalizationFields,
    forbidden: [
      "Historical price or discount as current Product truth",
      "Cross-SKU or Product-configuration substitution",
      "Unsupported factual Product claims",
      "A purchase territory not selected by Strategy"
    ]
  };
}

export function assertExecutionFeasible(input: CreativeInputSnapshot): ExecutionFeasibilityPlan {
  const plan = buildExecutionFeasibilityPlan(input);
  const blocked = plan.requirements.filter(
    (item) => item.resolution === "UNSUPPORTED_REQUIRED"
  );
  if (blocked.length) {
    throw new DomainError(
      "CONCEPT_EXECUTION_UNSUPPORTED",
      blocked
        .map((item) => `${item.code}: ${item.reason}`)
        .join(" ")
    );
  }
  return plan;
}
