import type { DashboardIntegrationViewModel } from "../../src/domain/dashboard/types";
import { ActionButton } from "./primitives";

/**
 * Renderer for the deliberately small, provider-neutral Dashboard contract.
 * Integrations provide plain text data only; this component never receives an
 * extension object, a credential, or arbitrary markup.
 */
export function IntegrationCards(props: {
  integrations: readonly DashboardIntegrationViewModel[];
  busy: boolean;
  actionPending: boolean;
  onAction: (integrationId: string, actionId: string) => void;
}) {
  if (props.integrations.length === 0) {
    return null;
  }

  return (
    <section class="section integration-cards-section">
      <div class="integration-cards">
        {props.integrations.map((integration) => (
          <article key={integration.id} class={`integration-card integration-status-${integration.status}`}>
            <div class="integration-card-head">
              <div>
                <div class="integration-card-title">{integration.title}</div>
                {integration.description ? (
                  <div class="integration-card-description">{integration.description}</div>
                ) : null}
              </div>
              <div class="integration-card-status">{integration.statusMessage ?? integration.status}</div>
            </div>
            {integration.details?.length ? (
              <dl class="integration-card-details">
                {integration.details.map((detail) => (
                  <div
                    key={`${detail.label}:${detail.value}`}
                    class={`integration-card-detail is-${detail.emphasis ?? "normal"}`}
                  >
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {integration.metrics?.length ? (
              <div class="integration-card-metrics">
                {integration.metrics.map((metric) => (
                  <div
                    key={`${metric.label}:${metric.value}`}
                    class="integration-card-metric"
                    title={metric.description}
                  >
                    <div>{metric.label}</div>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            ) : null}
            {integration.actions.length ? (
              <div class="integration-card-actions">
                {integration.actions.map((action) => (
                  <ActionButton
                    key={action.id}
                    class={`toolbar-btn integration-card-action is-${action.tone ?? "default"}`}
                    pending={props.actionPending}
                    disabled={props.busy || action.enabled === false}
                    tooltip={action.tooltip}
                    onClick={() => props.onAction(integration.id, action.id)}
                  >
                    {action.label}
                  </ActionButton>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
