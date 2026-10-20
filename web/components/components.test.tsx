// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PantryList, type PantryRow } from "./pantry-list";
import { StatusBadge, TrustBadge } from "./status";

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
afterEach(cleanup);

describe("trust & status badges", () => {
  it("labels machine guesses without color alone", () => {
    render(
      <>
        <TrustBadge trust="provisional" />
        <TrustBadge trust="unverified" />
        <TrustBadge trust="confirmed" />
        <StatusBadge status="critical" />
        <StatusBadge status="consumed" />
      </>,
    );
    expect(screen.getByText("provisional").getAttribute("title")).toMatch(/not yet confirmed/);
    expect(screen.getByText("unverified")).toBeTruthy();
    expect(screen.queryByText("confirmed")).toBeNull();
    expect(screen.getByText("Running low")).toBeTruthy();
    expect(screen.getByText("Out")).toBeTruthy();
  });
});

const row = (o: Partial<PantryRow>): PantryRow => ({
  id: o.name ?? "x",
  name: "x",
  location: "fridge",
  status: "stocked",
  amount: "~2",
  useBy: null,
  useByTone: null,
  itemTrust: "confirmed",
  lastTrust: null,
  ...o,
});

describe("PantryList", () => {
  const rows = [
    row({ name: "Eggs", amount: "~4 eggs", useBy: "use by Oct 24", useByTone: "soon" }),
    row({ name: "Oat Milk", status: "consumed", lastTrust: "provisional" }),
    row({ name: "Frozen Peas", location: "freezer" }),
    row({ name: "Kombucha", location: "pantry", itemTrust: "unverified", status: "unknown" }),
  ];
  const locations: [string, string][] = [
    ["fridge", "Fridge"],
    ["freezer", "Freezer"],
    ["pantry", "Pantry"],
  ];

  it("groups by location and shows trust and use-by", () => {
    render(<PantryList rows={rows} locations={locations} />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Fridge",
      "Freezer",
      "Pantry",
    ]);
    expect(screen.getByText("use by Oct 24").className).toMatch(/text-warn/);
    expect(screen.getByText("provisional")).toBeTruthy();
    expect(screen.getByText("unverified")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Eggs/ }).getAttribute("href")).toBe("/pantry/Eggs");
  });

  it("searches and filters to low / out", () => {
    render(<PantryList rows={rows} locations={locations} />);
    fireEvent.change(screen.getByLabelText("Search the pantry"), { target: { value: "milk" } });
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual([
      expect.stringContaining("Oat Milk"),
    ]);
    fireEvent.change(screen.getByLabelText("Search the pantry"), { target: { value: "" } });
    const toggle = screen.getByRole("button", { name: "Low / out (1)" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search the pantry"), { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches.")).toBeTruthy();
  });
});
