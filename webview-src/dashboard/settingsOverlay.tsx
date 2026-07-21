import type {
  DashboardCopy,
  DashboardSettingKey,
  DashboardSettings,
  DashboardState
} from "../../src/domain/dashboard/types";
import {
  SettingsDiscreteSlider,
  SettingsLanguageBlock,
  SettingsPathBlock,
  SettingsSegmentBlock,
  SettingsThemeBlock,
  SettingsThresholdBlock,
  SettingsToggleBlock
} from "./components";
import { formatTemplate, formatTimestamp } from "./helpers";

const AUTO_REFRESH_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const AUTO_REFRESH_SCALE_VALUES = [1, 15, 30, 45, 60];
const AUTO_SWITCH_VALUES = Array.from({ length: 21 }, (_, index) => index);
const AUTO_SWITCH_LOCK_VALUES = [0, 5, 10, 15, 30, 60, 120];
const HOT_SWITCH_GRACE_VALUES = [10, 30, 60, 90, 120, 180, 300];
const WARNING_VALUES = Array.from({ length: 18 }, (_, index) => 5 + index * 5);
const WARNING_SCALE_VALUES = [5, 20, 35, 50, 65, 80, 90];

export function SettingsOverlay(props: {
  open: boolean;
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  settings: DashboardSettings;
  tokenAutomation: DashboardState["tokenAutomation"];
  onClose: () => void;
  onPatchSettings: (patch: Partial<DashboardSettings>) => void;
  onSendSetting: (key: DashboardSettingKey, value: string | number | boolean) => void;
  onAutoRefreshToggle: (enabled: boolean) => void;
  onAutoRefreshValue: (minutes: number) => void;
  onThresholdPreview: (key: "yellow" | "green", value: number) => void;
  onThresholdCommit: (key: "yellow" | "green", value: number) => void;
  onPickCodexAppPath: () => void;
  onClearCodexAppPath: () => void;
}) {
  const patchAndSend = (key: DashboardSettingKey, value: string | number | boolean) => {
    props.onPatchSettings({ [key]: value } as Partial<DashboardSettings>);
    props.onSendSetting(key, value);
  };

  return (
    <div class={`overlay ${props.open ? "open" : ""}`} onClick={props.onClose}>
      <div class="settings-modal" onClick={(event) => event.stopPropagation()}>
        <div class="settings-modal-head">
          <div class="settings-modal-title">{props.copy.settingsTitle}</div>
          <button class="settings-close" type="button" onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-modal-body">
          <SettingsThemeBlock
            lang={props.lang}
            settings={props.settings}
            onChange={(value) => {
              props.onPatchSettings({ dashboardTheme: value });
              props.onSendSetting("dashboardTheme", value);
            }}
          />
          <SettingsLanguageBlock
            copy={props.copy}
            settings={props.settings}
            onChange={(value) => {
              props.onPatchSettings({ displayLanguage: value });
              props.onSendSetting("displayLanguage", value);
            }}
          />
          <SettingsSegmentBlock
            title={props.copy.localUsageSettingsTitle}
            sub={props.copy.localUsageSettingsSub}
            options={[
              {
                key: "local-usage-24h",
                title: props.copy.localUsageRange24Hours,
                description: props.copy.localUsageRange24HoursDesc,
                active: props.settings.localUsageDefaultRange === "24h",
                onClick: () => patchAndSend("localUsageDefaultRange", "24h")
              },
              {
                key: "local-usage-7d",
                title: props.copy.localUsageRange7Days,
                description: props.copy.localUsageRange7DaysDesc,
                active: props.settings.localUsageDefaultRange === "7d",
                onClick: () => patchAndSend("localUsageDefaultRange", "7d")
              },
              {
                key: "local-usage-14d",
                title: props.copy.localUsageRange14Days,
                description: props.copy.localUsageRange14DaysDesc,
                active: props.settings.localUsageDefaultRange === "14d",
                onClick: () => patchAndSend("localUsageDefaultRange", "14d")
              }
            ]}
          />
          <SettingsToggleBlock
            title={props.copy.localUsagePriceSettingsTitle}
            sub={props.copy.localUsagePriceSettingsSub}
            enabled={props.settings.localUsageShowEquivalentPrice}
            onToggle={(enabled) => patchAndSend("localUsageShowEquivalentPrice", enabled)}
          >
            <div class="settings-note">{props.copy.localUsagePriceSettingsNote}</div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={props.copy.codexAppRestartTitle}
            sub={props.copy.codexAppRestartSub}
            enabled={props.settings.codexAppRestartEnabled}
            onToggle={(enabled) => patchAndSend("codexAppRestartEnabled", enabled)}
          >
            <div class={`settings-stack ${props.settings.codexAppRestartEnabled ? "" : "is-hidden"}`}>
              <div class="settings-segment">
                <button
                  class={`segment-btn ${props.settings.codexAppRestartMode === "auto" ? "active" : ""}`}
                  type="button"
                  onClick={() => patchAndSend("codexAppRestartMode", "auto")}
                >
                  <span class="segment-title">{props.copy.restartModeAuto}</span>
                  <span class="segment-copy">{props.copy.restartModeAutoDesc}</span>
                </button>
                <button
                  class={`segment-btn ${props.settings.codexAppRestartMode === "manual" ? "active" : ""}`}
                  type="button"
                  onClick={() => patchAndSend("codexAppRestartMode", "manual")}
                >
                  <span class="segment-title">{props.copy.restartModeManual}</span>
                  <span class="segment-copy">{props.copy.restartModeManualDesc}</span>
                </button>
              </div>
              <div class="settings-note">{props.copy.restartModeNote}</div>
              <SettingsPathBlock
                copy={props.copy}
                pathValue={props.settings.resolvedCodexAppPath}
                hasCustomPath={Boolean(props.settings.codexAppPath)}
                compact
                onPick={props.onPickCodexAppPath}
                onClear={props.onClearCodexAppPath}
              />
            </div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={props.copy.autoRefreshTitle}
            sub={props.copy.autoRefreshSub}
            enabled={props.settings.autoRefreshMinutes > 0}
            onToggle={props.onAutoRefreshToggle}
          >
            <div class={`settings-stack ${props.settings.autoRefreshMinutes > 0 ? "" : "is-hidden"}`}>
              <SettingsDiscreteSlider
                value={props.settings.autoRefreshMinutes}
                values={AUTO_REFRESH_VALUES}
                accent="violet"
                scaleValues={AUTO_REFRESH_SCALE_VALUES}
                valueLabel={(value) => formatTemplate(props.copy.autoRefreshValueTemplate, value)}
                description={(value) => formatTemplate(props.copy.autoRefreshValueDescTemplate, value)}
                onPreview={(value) => props.onPatchSettings({ autoRefreshMinutes: value })}
                onCommit={props.onAutoRefreshValue}
              />
            </div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={props.copy.hourlyQuotaControlTitle}
            sub={props.copy.hourlyQuotaControlSub}
            enabled={props.settings.hourlyQuotaControlEnabled}
            onToggle={(enabled) => patchAndSend("hourlyQuotaControlEnabled", enabled)}
          >
            <div class="settings-note">
              {props.settings.hourlyQuotaControlEnabled
                ? props.copy.hourlyQuotaControlOnDesc
                : props.copy.hourlyQuotaControlOffDesc}
            </div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={props.copy.autoSwitchTitle}
            sub={props.copy.autoSwitchSub}
            enabled={props.settings.autoSwitchEnabled}
            onToggle={(enabled) => patchAndSend("autoSwitchEnabled", enabled)}
          >
            <div class={`settings-stack ${props.settings.autoSwitchEnabled ? "" : "is-hidden"}`}>
              {props.settings.hourlyQuotaControlEnabled ? (
                <SettingsDiscreteSlider
                  value={props.settings.autoSwitchHourlyThreshold}
                  values={AUTO_SWITCH_VALUES}
                  accent="violet"
                  sparseScale
                  valueLabel={(value) => `${value}%`}
                  description={(value) =>
                    formatTemplate(props.copy.autoSwitchThresholdDescTemplate, {
                      label: props.copy.hourlyLabel,
                      value
                    })
                  }
                  onPreview={(value) => props.onPatchSettings({ autoSwitchHourlyThreshold: value })}
                  onCommit={(value) => patchAndSend("autoSwitchHourlyThreshold", value)}
                />
              ) : null}
              <SettingsDiscreteSlider
                value={props.settings.autoSwitchWeeklyThreshold}
                values={AUTO_SWITCH_VALUES}
                accent="sky"
                sparseScale
                valueLabel={(value) => `${value}%`}
                description={(value) =>
                  formatTemplate(props.copy.autoSwitchThresholdDescTemplate, {
                    label: props.copy.weeklyLabel,
                    value
                  })
                }
                onPreview={(value) => props.onPatchSettings({ autoSwitchWeeklyThreshold: value })}
                onCommit={(value) => patchAndSend("autoSwitchWeeklyThreshold", value)}
              />
              <SettingsToggleBlock
                title={props.copy.autoSwitchReloadTitle}
                sub={props.copy.autoSwitchReloadSub}
                enabled={props.settings.autoSwitchReloadWindowEnabled}
                onToggle={(enabled) => patchAndSend("autoSwitchReloadWindowEnabled", enabled)}
              />
              <div class="settings-block-head">
                <div class="settings-block-title">{props.copy.autoSwitchLockMinutesTitle}</div>
                <div class="settings-block-sub">{props.copy.autoSwitchLockMinutesSub}</div>
              </div>
              <SettingsDiscreteSlider
                value={props.settings.autoSwitchLockMinutes}
                values={AUTO_SWITCH_LOCK_VALUES}
                accent="violet"
                valueLabel={(value) =>
                  value === 0
                    ? props.copy.autoSwitchLockOff
                    : formatTemplate(props.copy.autoSwitchLockValueTemplate, value)
                }
                description={(value) =>
                  value === 0
                    ? props.copy.autoSwitchLockMinutesSub
                    : formatTemplate(props.copy.autoSwitchLockValueDescTemplate, value)
                }
                scaleValues={AUTO_SWITCH_LOCK_VALUES}
                onPreview={(value) => props.onPatchSettings({ autoSwitchLockMinutes: value })}
                onCommit={(value) => patchAndSend("autoSwitchLockMinutes", value)}
              />
              <div class="settings-note">{props.copy.autoSwitchAnyNote}</div>
            </div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={
              props.lang === "zh"
                ? "无感切号（实验性）"
                : props.lang === "zh-hant"
                  ? "無感切換（實驗性）"
                  : "Seamless account switching (experimental)"
            }
            sub={
              props.lang === "zh"
                ? "开启后使用免 reload 切换和会话恢复；关闭后恢复 Manager 原有的账号写入与 reload 流程，已安装的 runtime 会保留。"
                : props.lang === "zh-hant"
                  ? "啟用後使用免 reload 切換和對話恢復；關閉後恢復 Manager 原有的帳號寫入與 reload 流程，已安裝的 runtime 會保留。"
                  : "Use no-reload switching and conversation recovery when enabled. When disabled, restore Manager's original persisted-account and reload workflow while keeping the runtime installed."
            }
            enabled={props.settings.seamlessSwitchEnabled}
            onToggle={(enabled) => patchAndSend("seamlessSwitchEnabled", enabled)}
          >
            <div class={`settings-stack ${props.settings.seamlessSwitchEnabled ? "" : "is-hidden"}`}>
              <SettingsToggleBlock
                title={
                  props.lang === "zh"
                    ? "额度分档无感平衡"
                    : props.lang === "zh-hant"
                      ? "額度分檔無感平衡"
                      : "Seamless quota-band balancing"
                }
                sub={
                  props.lang === "zh"
                    ? "无需开启官方自动切号或五小时配额控制；当前账号下降一档后，只通过无感 runtime 切到池中额度更充足、最久未使用的账号。"
                    : props.lang === "zh-hant"
                      ? "無需啟用官方自動切換或五小時配額控制；目前帳號下降一檔後，只透過無感 runtime 切到池中額度更充足、最久未使用的帳號。"
                      : "Does not require upstream Auto Switch or 5-hour quota control. After a band drop, it switches only through the seamless runtime to the strongest least-recently-used pool account."
                }
                enabled={props.settings.seamlessSwitchQuotaBandsEnabled}
                onToggle={(enabled) => patchAndSend("seamlessSwitchQuotaBandsEnabled", enabled)}
              />
              <div class={`settings-stack ${props.settings.seamlessSwitchQuotaBandsEnabled ? "" : "is-hidden"}`}>
                <SettingsSegmentBlock
                  title={props.lang === "zh" ? "额度分档" : props.lang === "zh-hant" ? "額度分檔" : "Quota band size"}
                  sub={
                    props.lang === "zh"
                      ? "选择五小时额度下降多少时触发一次无感平衡；修改后会重新建立基线。"
                      : props.lang === "zh-hant"
                        ? "選擇五小時額度下降多少時觸發一次無感平衡；修改後會重新建立基線。"
                        : "Choose how much 5-hour quota must drop before seamless balancing runs; changing it establishes a new baseline."
                  }
                  options={([20, 25, 33, 50] as const).map((size) => ({
                    key: `quota-band-${size}`,
                    title:
                      size === 20 ? "1/5 (20%)" : size === 25 ? "1/4 (25%)" : size === 33 ? "1/3 (33%)" : "1/2 (50%)",
                    description:
                      props.lang === "zh"
                        ? size === 20
                          ? "五档，切换更均衡"
                          : size === 25
                            ? "四档"
                            : size === 33
                              ? "三档"
                              : "两档，切换更少"
                        : props.lang === "zh-hant"
                          ? size === 20
                            ? "五檔，切換更均衡"
                            : size === 25
                              ? "四檔"
                              : size === 33
                                ? "三檔"
                                : "兩檔，切換更少"
                          : size === 20
                            ? "Five bands; smoother balance"
                            : size === 25
                              ? "Four bands"
                              : size === 33
                                ? "Three bands"
                                : "Two bands; fewer switches",
                    active: props.settings.seamlessSwitchQuotaBandSize === size,
                    onClick: () => patchAndSend("seamlessSwitchQuotaBandSize", size)
                  }))}
                />
                <SettingsSegmentBlock
                  title={
                    props.lang === "zh"
                      ? "储备账号切换阈值"
                      : props.lang === "zh-hant"
                        ? "儲備帳號切換閾值"
                        : "Reserve transition threshold"
                  }
                  sub={
                    props.lang === "zh"
                      ? "优先使用仍有五小时窗口且额度高于阈值的账号；全部触达阈值后才启用长期额度最高的储备账号。储备账号的长期额度触达同一阈值后，会优先切回已恢复的五小时账号。"
                      : props.lang === "zh-hant"
                        ? "優先使用仍有五小時視窗且額度高於閾值的帳號；全部觸達閾值後才啟用長期額度最高的儲備帳號。儲備帳號的長期額度觸達同一閾值後，會優先切回已恢復的五小時帳號。"
                        : "Prefer accounts with a fresh 5-hour window above this threshold. Use the reserve account with the strongest long-term quota only after all safe windowed accounts reach it; switch back to a recovered windowed account before another reserve."
                  }
                  options={([1, 2, 3] as const).map((threshold) => ({
                    key: `reserve-threshold-${threshold}`,
                    title: `${threshold}%${threshold === 3 ? (props.lang === "zh" ? "（默认）" : props.lang === "zh-hant" ? "（預設）" : " (default)") : ""}`,
                    description:
                      props.lang === "zh"
                        ? threshold === 1
                          ? "尽量用完五小时额度"
                          : threshold === 2
                            ? "兼顾利用率与切换余量"
                            : "预留更多安全余量"
                        : props.lang === "zh-hant"
                          ? threshold === 1
                            ? "盡量用完五小時額度"
                            : threshold === 2
                              ? "兼顧利用率與切換餘量"
                              : "預留更多安全餘量"
                          : threshold === 1
                            ? "Maximize 5-hour quota use"
                            : threshold === 2
                              ? "Balance utilization and headroom"
                              : "Keep more switching headroom",
                    active: props.settings.seamlessSwitchReserveThreshold === threshold,
                    onClick: () => patchAndSend("seamlessSwitchReserveThreshold", threshold)
                  }))}
                />
                <SettingsToggleBlock
                  title={
                    props.lang === "zh"
                      ? "1% 耗尽保护（Free 优先）"
                      : props.lang === "zh-hant"
                        ? "1% 耗盡保護（Free 優先）"
                        : "1% exhaustion protection (Free first)"
                  }
                  sub={
                    props.lang === "zh"
                      ? "Free 五小时额度降到 1% 或更低时，优先切到池中五小时额度最高、周额度仍安全的 Free 账号；没有可用 Free 时回到混合选择。会立即中断并自动 Continue，可能重复非幂等外部操作。"
                      : props.lang === "zh-hant"
                        ? "Free 五小時額度降到 1% 或更低時，優先切到池中五小時額度最高、週額度仍安全的 Free 帳號；沒有可用 Free 時回到混合選擇。會立即中斷並自動 Continue，可能重複非冪等外部操作。"
                        : "When a Free 5-hour quota reaches 1% or lower, first switch to the eligible Free pool account with the most 5-hour quota; otherwise use mixed selection. It interrupts and auto-Continues, so non-idempotent external actions can repeat."
                  }
                  enabled={props.settings.seamlessSwitchEmergencySwitchEnabled}
                  onToggle={(enabled) => patchAndSend("seamlessSwitchEmergencySwitchEnabled", enabled)}
                />
              </div>
              <SettingsSegmentBlock
                title={
                  props.lang === "zh"
                    ? "普通会话策略"
                    : props.lang === "zh-hant"
                      ? "一般對話策略"
                      : "Ordinary-turn policy"
                }
                sub={
                  props.lang === "zh"
                    ? "只处理等待期后仍在运行的普通会话；Goal 始终使用暂停与恢复语义。"
                    : props.lang === "zh-hant"
                      ? "只處理等待期後仍在執行的一般對話；Goal 一律使用暫停與恢復語義。"
                      : "Applies only to ordinary turns still running after the grace period; Goals always use pause and resume semantics."
                }
                note={
                  props.lang === "zh"
                    ? `${props.settings.hotSwitchEnabled ? "Runtime 已安装。" : "Runtime 未安装，无感切号将安全跳过。"} 安装或移除 runtime 请使用命令面板。`
                    : props.lang === "zh-hant"
                      ? `${props.settings.hotSwitchEnabled ? "Runtime 已安裝。" : "Runtime 未安裝，無感切換將安全略過。"} 安裝或移除 runtime 請使用命令面板。`
                      : `${props.settings.hotSwitchEnabled ? "Runtime installed." : "Runtime not installed; seamless switching will fail closed."} Use the Command Palette to install or remove the runtime.`
                }
                options={[
                  {
                    key: "hot-switch-defer",
                    title:
                      props.lang === "zh"
                        ? "延后切换（推荐）"
                        : props.lang === "zh-hant"
                          ? "延後切換（建議）"
                          : "Defer (recommended)",
                    description:
                      props.lang === "zh"
                        ? "普通会话继续运行，本次切换保持待重试。"
                        : props.lang === "zh-hant"
                          ? "一般對話繼續執行，本次切換留待重試。"
                          : "Keep ordinary turns running and retry the switch later.",
                    active: props.settings.hotSwitchLongTurnPolicy === "defer",
                    onClick: () => patchAndSend("hotSwitchLongTurnPolicy", "defer")
                  },
                  {
                    key: "hot-switch-interrupt",
                    title:
                      props.lang === "zh"
                        ? "中断后手动继续"
                        : props.lang === "zh-hant"
                          ? "中斷後手動繼續"
                          : "Interrupt; continue manually",
                    description:
                      props.lang === "zh"
                        ? "中断普通会话并切号，不自动发送继续。"
                        : props.lang === "zh-hant"
                          ? "中斷一般對話並切換帳號，不自動傳送繼續。"
                          : "Interrupt ordinary turns and switch without starting a continuation.",
                    active: props.settings.hotSwitchLongTurnPolicy === "interrupt",
                    onClick: () => patchAndSend("hotSwitchLongTurnPolicy", "interrupt")
                  },
                  {
                    key: "hot-switch-continue",
                    title:
                      props.lang === "zh"
                        ? "中断并自动继续"
                        : props.lang === "zh-hant"
                          ? "中斷並自動繼續"
                          : "Interrupt and auto-continue",
                    description:
                      props.lang === "zh"
                        ? "实验性：在同一线程发送一次带恢复提示的“Continue”。非幂等外部操作仍有重复风险。"
                        : props.lang === "zh-hant"
                          ? "實驗性：在同一執行緒傳送一次帶恢復提示的「Continue」。非冪等外部操作仍有重複風險。"
                          : "Experimental: send one marked Continue turn in the same thread. Non-idempotent external actions can still repeat.",
                    active: props.settings.hotSwitchLongTurnPolicy === "interruptAndContinue",
                    onClick: () => patchAndSend("hotSwitchLongTurnPolicy", "interruptAndContinue")
                  }
                ]}
              />
              <div class="settings-block-head">
                <div class="settings-block-title">
                  {props.lang === "zh"
                    ? "无感切号等待时间"
                    : props.lang === "zh-hant"
                      ? "無感切換等待時間"
                      : "Seamless-switch grace period"}
                </div>
                <div class="settings-block-sub">
                  {props.lang === "zh"
                    ? "超时后按上面的策略处理；Goal 会被中断、切号并恢复。"
                    : props.lang === "zh-hant"
                      ? "逾時後依上述策略處理；Goal 會被中斷、切換帳號並恢復。"
                      : "After this delay the selected policy applies; Goals are interrupted, switched, and resumed."}
                </div>
              </div>
              <SettingsDiscreteSlider
                value={props.settings.hotSwitchGraceSeconds}
                values={HOT_SWITCH_GRACE_VALUES}
                accent="violet"
                scaleValues={HOT_SWITCH_GRACE_VALUES}
                valueLabel={(value) => `${value}s`}
                description={(value) =>
                  props.lang === "zh"
                    ? `等待 ${value} 秒后处理仍在运行的 turn。`
                    : props.lang === "zh-hant"
                      ? `等待 ${value} 秒後處理仍在執行的 turn。`
                      : `Handle turns still active after ${value} seconds.`
                }
                onPreview={(value) => props.onPatchSettings({ hotSwitchGraceSeconds: value })}
                onCommit={(value) => patchAndSend("hotSwitchGraceSeconds", value)}
              />
            </div>
          </SettingsToggleBlock>
          <SettingsToggleBlock
            title={props.copy.warningTitle}
            sub={props.settings.hourlyQuotaControlEnabled ? props.copy.warningSub : props.copy.warningWeeklyOnlySub}
            enabled={props.settings.quotaWarningEnabled}
            onToggle={(enabled) => patchAndSend("quotaWarningEnabled", enabled)}
          >
            <div class={`settings-stack ${props.settings.quotaWarningEnabled ? "" : "is-hidden"}`}>
              <SettingsDiscreteSlider
                value={props.settings.quotaWarningThreshold}
                values={WARNING_VALUES}
                accent="amber"
                scaleValues={WARNING_SCALE_VALUES}
                valueLabel={(value) => `${value}%`}
                description={(value) => formatTemplate(props.copy.warningValueDescTemplate, value)}
                onPreview={(value) => props.onPatchSettings({ quotaWarningThreshold: value })}
                onCommit={(value) => patchAndSend("quotaWarningThreshold", value)}
              />
            </div>
          </SettingsToggleBlock>
          <SettingsThresholdBlock
            copy={props.copy}
            settings={props.settings}
            onPreview={props.onThresholdPreview}
            onCommit={props.onThresholdCommit}
          />
          <SettingsToggleBlock
            title={props.copy.tokenAutomationTitle}
            sub={props.copy.tokenAutomationSub}
            enabled={props.settings.backgroundTokenRefreshEnabled}
            onToggle={(enabled) => patchAndSend("backgroundTokenRefreshEnabled", enabled)}
          >
            <div class={`settings-stack ${props.settings.backgroundTokenRefreshEnabled ? "" : "is-hidden"}`}>
              <div class="settings-note-list">
                <div class="settings-note-item">
                  <span>{props.copy.tokenAutomationLastCheck}</span>
                  <strong>{formatTimestamp(props.tokenAutomation.lastCheckAt, props.copy.never)}</strong>
                </div>
                <div class="settings-note-item">
                  <span>{props.copy.tokenAutomationLastRefresh}</span>
                  <strong>{formatTimestamp(props.tokenAutomation.lastRefreshAt, props.copy.never)}</strong>
                </div>
                <div class="settings-note-item">
                  <span>{props.copy.tokenAutomationNextCheck}</span>
                  <strong>{formatTimestamp(props.tokenAutomation.nextCheckAt, props.copy.never)}</strong>
                </div>
                <div class="settings-note-item">
                  <span>{props.copy.tokenAutomationLastFailure}</span>
                  <strong>{props.tokenAutomation.lastFailureMessage ?? props.copy.never}</strong>
                </div>
              </div>
            </div>
          </SettingsToggleBlock>
          <SettingsSegmentBlock
            title={props.copy.debugTitle}
            sub={props.copy.debugSub}
            note={props.copy.debugNote}
            options={[
              {
                key: "debug-on",
                title: props.copy.debugOn,
                description: props.copy.debugOnDesc,
                active: props.settings.debugNetwork,
                onClick: () => patchAndSend("debugNetwork", true)
              },
              {
                key: "debug-off",
                title: props.copy.debugOff,
                description: props.copy.debugOffDesc,
                active: !props.settings.debugNetwork,
                onClick: () => patchAndSend("debugNetwork", false)
              }
            ]}
          />
        </div>
      </div>
    </div>
  );
}
