import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";
export const epochs = sqliteTable("siftera_epochs", { uid: text("uid").primaryKey(), version: integer("version").notNull().default(0) });
export const records = sqliteTable("siftera_records", {
  uid: text("uid").notNull(), collection: text("collection").notNull(), id: text("id").notNull(), data: text("data").notNull(), sortKey: text("sort_key").notNull().default(""),
}, table => [primaryKey({columns:[table.uid,table.collection,table.id]}), index("siftera_records_list").on(table.uid,table.collection,table.sortKey,table.id)]);
export const sources = sqliteTable("siftera_sources", {
  uid: text("uid").notNull(), id: text("id").notNull(), data: text("data").notNull(),
}, table => [primaryKey({columns:[table.uid,table.id]})]);
