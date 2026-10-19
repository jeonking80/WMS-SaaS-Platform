import { describe, expect, it, vi } from "vitest";
vi.mock("@/server/auth/access", () => ({ requireIdentity: vi.fn(), requireRole: vi.fn() }));
vi.mock("@/server/db/tenant", () => ({ withTenant: vi.fn() }));
import { validateMasterInput } from "@/server/master-data";

describe("master data input", () => {
  it("normalizes codes and names", () => {
    expect(validateMasterInput({ code: " abc-1 ", name: " Name " }, "items")).toEqual({ code: "ABC-1", name: "Name" });
  });
  it("allows partial updates and boolean activation", () => {
    expect(validateMasterInput({ active: false }, "warehouses", true)).toEqual({ active: false });
    expect(validateMasterInput({ name: " renamed " }, "items", true)).toEqual({ name: "renamed" });
  });
  it.each([
    {}, { code: " ", name: "x" }, { code: "x", name: " " },
    { code: "x".repeat(65), name: "x" }, { code: "x", name: "x".repeat(129) },
    { code: 1, name: "x" }, { code: "x", name: "x", tenant_id: "forged" },
    { code: "x", name: "x", active: false },
  ])("rejects invalid creation input %#", (input) => {
    expect(() => validateMasterInput(input, "items")).toThrow("INVALID_INPUT");
  });
  it("requires valid parent on location creation and forbids moving a location", () => {
    const warehouse_id = "11111111-1111-4111-8111-111111111111";
    expect(validateMasterInput({ code: "a", name: "b", warehouse_id }, "locations")).toEqual({ code: "A", name: "b", warehouse_id });
    expect(() => validateMasterInput({ code: "a", name: "b" }, "locations")).toThrow("INVALID_INPUT");
    expect(() => validateMasterInput({ warehouse_id }, "locations", true)).toThrow("INVALID_INPUT");
  });
  it.each([{}, { active: "false" }, { name: null }, { code: "" }, { tenant_id: "forged" }])("rejects invalid patch %#", (input) => {
    expect(() => validateMasterInput(input, "items", true)).toThrow("INVALID_INPUT");
  });
});
