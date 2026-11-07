import { parseListen } from "../config/listen-address.ts";
import type { ProxyConfigStore } from "../config/proxy-config-store.ts";
import type { ClientKeyStore } from "./client-keys.ts";
import { startSharedLoginListener, type SharedLoginListener } from "./listener.ts";
import type { LoginSource } from "./login.ts";

export interface SharedLoginStatus {
  enabled: boolean;
  listen: string;
  /** Set when the command line fixes the value; the UI cannot edit it until restart. */
  enabledOverride?: boolean;
  listenOverride?: string;
  running: boolean;
  origin?: string;
  /** Why the listener is not running although it is enabled. */
  error?: string;
  tls: boolean;
}

export interface SharedLoginService {
  readonly keys: ClientKeyStore;
  readonly login: LoginSource;
  status(): SharedLoginStatus;
  /** Validates and saves settings, then applies them to the listener. */
  update(settings: { enabled?: boolean; listen?: string }): Promise<void>;
  close(): Promise<void>;
}

export interface SharedLoginServiceOptions {
  config: ProxyConfigStore;
  keys: ClientKeyStore;
  login: LoginSource;
  upstreamOrigin: string;
  tls?: { cert: string; key: string };
  enabledOverride?: boolean;
  listenOverride?: string;
  log: (line: string) => void;
}

export async function startSharedLoginService(
  options: SharedLoginServiceOptions,
): Promise<SharedLoginService> {
  const { config, keys, login, log } = options;
  let listener: SharedLoginListener | undefined;
  let running: { listen: string; origin: string } | undefined;
  let error: string | undefined;
  let queue: Promise<void> = Promise.resolve();

  const desired = () => {
    const saved = config.get().shared_login;
    return {
      enabled: options.enabledOverride ?? saved.enabled,
      listen: options.listenOverride ?? saved.listen,
    };
  };

  const stop = async () => {
    await listener?.close();
    listener = undefined;
    running = undefined;
  };

  const apply = async () => {
    const { enabled, listen } = desired();
    if (enabled && running?.listen === listen) return;
    await stop();
    error = undefined;
    if (!enabled) return;
    try {
      const { host, port } = parseListen(listen, "shared_login.listen");
      listener = await startSharedLoginListener({
        host,
        port,
        upstreamOrigin: options.upstreamOrigin,
        keys,
        login,
        tls: options.tls,
        log,
      });
      running = { listen, origin: listener.origin };
      log(`listening on ${listener.origin}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      log(`could not listen on ${listen}: ${error}`);
    }
  };

  // A failed step is logged and never blocks the steps queued after it.
  const enqueue = (step: () => Promise<void>) => {
    const run = queue.then(step);
    queue = run.catch((cause: unknown) => {
      log(`settings change failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return run;
  };
  const reconcile = () => enqueue(apply);

  await reconcile();

  return {
    keys,
    login,
    status() {
      const { enabled, listen } = desired();
      return {
        enabled,
        listen,
        enabledOverride: options.enabledOverride,
        listenOverride: options.listenOverride,
        running: running !== undefined,
        origin: running?.origin,
        error,
        tls: options.tls !== undefined,
      };
    },
    async update(settings) {
      if (settings.enabled !== undefined && options.enabledOverride !== undefined)
        throw new Error(
          "Shared Login is set on the command line; restart without --shared-login or --no-shared-login to edit it",
        );
      if (settings.listen !== undefined && options.listenOverride !== undefined)
        throw new Error(
          "The listen address is set on the command line; restart without --shared-login-listen to edit it",
        );
      const changes = Object.fromEntries(
        Object.entries(settings).filter(([, value]) => value !== undefined),
      );
      // Read, merge, and write in the queue, so concurrent updates never drop one another.
      await enqueue(async () => {
        const current = config.get();
        await config.replace({
          ...current,
          shared_login: { ...current.shared_login, ...changes },
        });
      });
      await reconcile();
    },
    async close() {
      await enqueue(stop);
    },
  };
}
