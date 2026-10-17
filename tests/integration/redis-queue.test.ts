import { describe, expect, it } from "vitest";
import { createRedisConnection } from "@koolezt/infrastructure";

const redisUrl = process.env.KOOLEZT_TEST_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;

integration("Redis/BullMQ infrastructure", () => {
  it("connects to the configured Redis service", async () => {
    const connection = createRedisConnection(redisUrl!);
    expect(await connection.ping()).toBe("PONG");
    await connection.quit();
  });
});
