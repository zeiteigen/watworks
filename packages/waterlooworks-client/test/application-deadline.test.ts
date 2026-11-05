import { describe, expect, test } from "bun:test";
import { applicationDeadline } from "../src/application-deadline.js";

describe("Toronto application deadlines", () => {
  test.each([
    ["Jul 15, 2027 11:59 PM", "2027-07-16T03:59:00.000Z"],
    ["Jan 15, 2027 11:59 PM", "2027-01-16T04:59:00.000Z"],
    ["Jul 15, 2027 12:00 AM", "2027-07-15T04:00:00.000Z"],
    ["Jan 15, 2027 12:00 PM", "2027-01-15T17:00:00.000Z"],
    ["2027-07-15T23:59:00-04:00", "2027-07-16T03:59:00.000Z"],
    ["2027-01-16T04:59:00Z", "2027-01-16T04:59:00.000Z"],
  ])("converts %s with the posting timezone", (input, expected) => {
    expect(applicationDeadline(input)).toBe(expected!);
  });

  test.each([undefined, "", "2027-07-15", "Jul 15, 2027", "Jul 15, 2027 00:59 AM", "Jul 15, 2027 13:00 PM", "Jul 15, 2027 10:60 AM", "Feb 30, 2027 10:00 AM", "Mar 14, 2027 2:30 AM", "Nov 7, 2027 1:30 AM"])("rejects unknown, ambiguous, or nonexistent wall time %s", input => {
    expect(applicationDeadline(input)).toBe("");
  });

  test.each([
    ["Mar 14, 2027 1:59 AM", "2027-03-14T06:59:00.000Z"],
    ["Mar 14, 2027 3:00 AM", "2027-03-14T07:00:00.000Z"],
    ["Nov 7, 2027 12:59 AM", "2027-11-07T04:59:00.000Z"],
    ["Nov 7, 2027 2:00 AM", "2027-11-07T07:00:00.000Z"],
  ])("accepts valid times next to DST transitions: %s", (input, expected) => {
    expect(applicationDeadline(input)).toBe(expected!);
  });
});
