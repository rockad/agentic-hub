/**
 * Pluggable Zero-Overhead OpenTelemetry (OTEL) Tracing layer for Jev.
 *
 * Design Principles:
 * 1. Zero Runtime Overhead When Inactive: If OTEL is not configured or enabled,
 *    tracing operations resolve to no-ops with zero heap allocations or async overhead.
 * 2. Decoupled Architecture: Core routing logic never imports OTEL packages directly.
 * 3. Hook Budget Safety: Fast CLI tools and Claude Code hooks exit immediately without
 *    stalling on network export flushes.
 */

export interface JevSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setError(err: Error | string): void;
  end(): void;
}

export interface JevTracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): JevSpan;
}

class NoopSpan implements JevSpan {
  setAttribute(_key: string, _value: string | number | boolean): void {}
  setError(_err: Error | string): void {}
  end(): void {}
}

class NoopTracer implements JevTracer {
  startSpan(_name: string, _attributes?: Record<string, string | number | boolean>): JevSpan {
    return new NoopSpan();
  }
}

let activeTracer: JevTracer = new NoopTracer();

/**
 * Initialize tracing dynamically if JEV_OTEL_ENABLED is set or an OTLP endpoint is configured.
 */
export async function initTracing(): Promise<JevTracer> {
  const isOtelEnabled =
    process.env.JEV_OTEL_ENABLED === 'true' ||
    Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!isOtelEnabled) {
    activeTracer = new NoopTracer();
    return activeTracer;
  }

  try {
    const { trace } = await import('@opentelemetry/api' as any);
    if (trace && typeof trace.getTracer === 'function') {
      activeTracer = {
        startSpan(name: string, attributes?: Record<string, string | number | boolean>) {
          const tracer = trace.getTracer('agentic-hub-jev', '2.3.0');
          const span = tracer.startSpan(name, { attributes });
          return {
            setAttribute: (k: string, v: string | number | boolean) => span.setAttribute(k, v),
            setError: (err: Error | string) =>
              span.recordException?.(err instanceof Error ? err : new Error(String(err))),
            end: () => span.end()
          };
        }
      };
    }
  } catch {
    activeTracer = new NoopTracer();
  }
  return activeTracer;
}

export function getTracer(): JevTracer {
  return activeTracer;
}
