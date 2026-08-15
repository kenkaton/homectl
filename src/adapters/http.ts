import type { Http } from "./types";

// レジストリ経由で http が注入されない文脈（scripts/setup.ts のメタデータ参照や単体テスト）用の
// 素の fetch。DO 内では必ず SiteDO.httpWithBudget が注入される（§13）。
export const plainHttp: Http = (_vendor, req) => fetch(req);

export class BudgetExceededError extends Error {
  constructor(readonly vendor: string) {
    super(`rate budget exhausted for vendor '${vendor}'`);
    this.name = "BudgetExceededError";
  }
}
