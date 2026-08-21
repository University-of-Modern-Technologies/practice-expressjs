CREATE TYPE "PermissionScope" AS ENUM ('ALL', 'OWN');
CREATE TYPE "DealStage" AS ENUM ('LEAD', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_nonempty_check" CHECK (btrim("email") <> ''),
    CONSTRAINT "users_name_nonempty_check" CHECK (btrim("name") <> '')
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_token_hash_nonempty_check" CHECK (btrim("token_hash") <> ''),
    CONSTRAINT "sessions_expiry_check" CHECK ("expires_at" > "created_at")
);

CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "roles_name_nonempty_check" CHECK (btrim("name") <> '')
);

CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permissions_key_format_check" CHECK ("key" ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$')
);

CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_id")
);

CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);

CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "first_name" VARCHAR(80) NOT NULL,
    "last_name" VARCHAR(80) NOT NULL,
    "email" VARCHAR(320),
    "phone" VARCHAR(32),
    "company" VARCHAR(160),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "contacts_first_name_nonempty_check" CHECK (btrim("first_name") <> ''),
    CONSTRAINT "contacts_last_name_nonempty_check" CHECK (btrim("last_name") <> ''),
    CONSTRAINT "contacts_deleted_at_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at")
);

CREATE TABLE "deals" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "contact_id" UUID,
    "title" VARCHAR(160) NOT NULL,
    "stage" "DealStage" NOT NULL DEFAULT 'LEAD',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "version" INTEGER NOT NULL DEFAULT 1,
    "expected_close_date" DATE,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    CONSTRAINT "deals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "deals_title_nonempty_check" CHECK (btrim("title") <> ''),
    CONSTRAINT "deals_amount_nonnegative_check" CHECK ("amount" >= 0),
    CONSTRAINT "deals_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "deals_probability_range_check" CHECK ("probability" BETWEEN 0 AND 100),
    CONSTRAINT "deals_version_positive_check" CHECK ("version" > 0),
    CONSTRAINT "deals_stage_probability_check" CHECK (
        ("stage" = 'WON' AND "probability" = 100) OR
        ("stage" = 'LOST' AND "probability" = 0) OR
        ("stage" NOT IN ('WON', 'LOST') AND "probability" < 100)
    ),
    CONSTRAINT "deals_closed_at_check" CHECK ("closed_at" IS NULL OR "closed_at" >= "created_at"),
    CONSTRAINT "deals_deleted_at_check" CHECK ("deleted_at" IS NULL OR "deleted_at" >= "created_at")
);

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" UUID,
    "changes" JSONB,
    "metadata" JSONB,
    "ip_address" INET,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_action_nonempty_check" CHECK (btrim("action") <> ''),
    CONSTRAINT "audit_logs_entity_type_nonempty_check" CHECK (btrim("entity_type") <> '')
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_is_active_idx" ON "users"("is_active");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");
CREATE INDEX "contacts_owner_id_deleted_at_idx" ON "contacts"("owner_id", "deleted_at");
CREATE INDEX "contacts_last_name_first_name_idx" ON "contacts"("last_name", "first_name");
CREATE INDEX "contacts_email_idx" ON "contacts"("email");
CREATE INDEX "contacts_company_idx" ON "contacts"("company");
CREATE INDEX "deals_owner_id_stage_deleted_at_idx" ON "deals"("owner_id", "stage", "deleted_at");
CREATE INDEX "deals_contact_id_idx" ON "deals"("contact_id");
CREATE INDEX "deals_stage_expected_close_date_idx" ON "deals"("stage", "expected_close_date");
CREATE INDEX "deals_deleted_at_idx" ON "deals"("deleted_at");
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contacts"
    ADD CONSTRAINT "contacts_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deals"
    ADD CONSTRAINT "deals_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deals"
    ADD CONSTRAINT "deals_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
