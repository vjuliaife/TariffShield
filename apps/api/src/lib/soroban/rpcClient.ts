import { rpc } from "@stellar/stellar-sdk";
import { registerSorobanLogger } from "./logger.js";

export function createRpcServer(url: string, opts?: rpc.Server.Options): rpc.Server {
  const server = new rpc.Server(url, {
    allowHttp: url.startsWith("http://"),
    ...opts,
  });
  registerSorobanLogger(server);
  return server;
}
