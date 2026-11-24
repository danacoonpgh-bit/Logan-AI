import "server-only";

// Hello world
import {
  EMPTY_EXIT_TEST_SALES,
  type ExitArm,
  type ExitTestSales,
} from "@/lib/exit-intent-config";

export async function readExitArm(): Promise<ExitArm | null> {
  return null;
}

export async function getExitTestSales(resetAtMs: number | null): Promise<Record<ExitArm, ExitTestSales>> {
  void resetAtMs;
  return EMPTY_EXIT_TEST_SALES;
}
