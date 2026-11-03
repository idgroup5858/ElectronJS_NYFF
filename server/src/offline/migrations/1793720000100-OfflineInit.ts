import { MigrationInterface, QueryRunner } from 'typeorm';

/** Offline kassa bazasi: nusxa / holat (`offline_kv`) va yuborilmagan buyurtmalar. */
export class OfflineInit1793720000100 implements MigrationInterface {
  name = 'OfflineInit1793720000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "offline_kv" ("key" character varying(60) NOT NULL, "value" jsonb NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_offline_kv" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "offline_orders" ("id" character varying(40) NOT NULL, "number" integer NOT NULL, "type" character varying(10) NOT NULL, "items" jsonb NOT NULL, "note" text NOT NULL DEFAULT '', "total" bigint NOT NULL, "payment" character varying(10) NOT NULL, "split" jsonb, "status" character varying(10) NOT NULL, "cashierId" character varying(40) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "readyAt" TIMESTAMP WITH TIME ZONE, "cancelledAt" TIMESTAMP WITH TIME ZONE, "cancelledBy" character varying(40), "rev" integer NOT NULL DEFAULT 0, "rejectedCode" character varying(40), CONSTRAINT "PK_offline_orders" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_offline_orders_createdAt" ON "offline_orders" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "offline_orders"`);
    await queryRunner.query(`DROP TABLE "offline_kv"`);
  }
}
