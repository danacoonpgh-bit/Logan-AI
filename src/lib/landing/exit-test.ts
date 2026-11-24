// Hello world
import type { ExitArm, ExitTestEvent } from "@/lib/exit-intent-config";

export function pickExitArm(): ExitArm {
  return "standard";
}
export function setExitArmCookie(arm: ExitArm): void {
  void arm;
}
export function clearExitArmCookie(): void {}
export function readExitArmCookie(): ExitArm | null {
  return null;
}
export function trackExitTest(arm: ExitArm, event: ExitTestEvent): void {
  void arm;
  void event;
}
