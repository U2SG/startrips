-- #345 / ST-067: Better Auth 1.6.23 does not generate a provider+subject
-- uniqueness constraint on its account table. Keep the generated auth schema
-- byte-exact, but enforce the external identity collision boundary in PostgreSQL
-- so native provider callbacks and the Startrips explicit linker share it.
CREATE UNIQUE INDEX "account_provider_subject_unique" ON "account" USING btree ("provider_id", "account_id");
