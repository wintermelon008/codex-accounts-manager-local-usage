import type { Sub2ApiGatewayController } from "./controller";

let controller: Sub2ApiGatewayController | undefined;

export function setSub2ApiGatewayController(next: Sub2ApiGatewayController | undefined): void {
  controller = next;
}

export function getSub2ApiGatewayController(): Sub2ApiGatewayController | undefined {
  return controller;
}
