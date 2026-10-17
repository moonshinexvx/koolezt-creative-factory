import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// These definitions are intentionally limited to the operational tables used by
// the repository. The reviewed SQL migration is the complete schema contract.
export const products = pgTable("products", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull(),
  defaultCta: text("default_cta").notNull(),
  creativeNotes: text("creative_notes"),
  personalizationVisualAuthority: jsonb("personalization_visual_authority"),
  active: boolean("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const creativeProjects = pgTable(
  "creative_projects",
  {
    id: uuid("id").primaryKey(),
    projectNumber: bigint("project_number", { mode: "number" }).notNull(),
    publicId: text("public_id").notNull(),
    productId: uuid("product_id").notNull(),
    state: text("state").notNull(),
    version: integer("version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [index("creative_projects_state_updated_idx").on(table.state, table.updatedAt)]
);

export const projectSnapshots = pgTable("creative_project_snapshots", {
  projectId: uuid("project_id").primaryKey(),
  aggregate: jsonb("aggregate").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
});

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    id: uuid("id").primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    type: text("type").notNull(),
    projectId: uuid("project_id").notNull(),
    targetId: uuid("target_id").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull()
  },
  (table) => [index("workflow_jobs_project_status_idx").on(table.projectId, table.status)]
);
