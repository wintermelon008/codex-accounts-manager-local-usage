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
                  props.lang === "zh" ? "分档切号" : props.lang === "zh-hant" ? "分檔切換" : "Quota-band switching"
                }
                sub={
                  props.lang === "zh"
                    ? "按五小时额度分档在无感池内平衡账号。"
                    : props.lang === "zh-hant"
                      ? "依五小時額度分檔在無感池內平衡帳號。"
                      : "Balance pool accounts by 5-hour quota bands."
                }
                enabled={props.settings.seamlessSwitchQuotaBandsEnabled}
                onToggle={(enabled) => patchAndSend("seamlessSwitchQuotaBandsEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.seamlessSwitchQuotaBandsEnabled ? "" : "is-hidden"}`}>
                  <SettingsSegmentBlock
                    title={props.lang === "zh" ? "分档方式" : props.lang === "zh-hant" ? "分檔方式" : "Band size"}
                    sub={
                      props.lang === "zh"
                        ? "下降一个分档时切换；修改后重新建立基线。"
                        : props.lang === "zh-hant"
                          ? "下降一個分檔時切換；修改後重新建立基線。"
                          : "Switch after a band drop; changing this resets the baseline."
                    }
                    options={([20, 25, 33, 50] as const).map((size) => ({
                      key: `quota-band-${size}`,
                      title:
                        size === 20 ? "1/5 (20%)" : size === 25 ? "1/4 (25%)" : size === 33 ? "1/3 (33%)" : "1/2 (50%)",
                      description:
                        props.lang === "zh"
                          ? size === 20
                            ? "五档，更均衡"
                            : size === 25
                              ? "四档"
                              : size === 33
                                ? "三档"
                                : "两档，更少切换"
                          : props.lang === "zh-hant"
                            ? size === 20
                              ? "五檔，更均衡"
                              : size === 25
                                ? "四檔"
                                : size === 33
                                  ? "三檔"
                                  : "兩檔，較少切換"
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
                  <div class="settings-block-head">
                    <div class="settings-block-title">
                      {props.lang === "zh" ? "等待时间" : props.lang === "zh-hant" ? "等待時間" : "Wait time"}
                    </div>
                    <div class="settings-block-sub">
                      {props.lang === "zh"
                        ? "触发后等待会话自然结束；超时后按切换策略处理。"
                        : props.lang === "zh-hant"
                          ? "觸發後等待對話自然結束；逾時後依切換策略處理。"
                          : "Wait for active turns to finish, then apply the switch policy."}
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
                        ? `最多 ${value} 秒`
                        : props.lang === "zh-hant"
                          ? `最多 ${value} 秒`
                          : `Up to ${value} seconds`
                    }
                    onPreview={(value) => props.onPatchSettings({ hotSwitchGraceSeconds: value })}
                    onCommit={(value) => patchAndSend("hotSwitchGraceSeconds", value)}
                  />
                </div>
              </SettingsToggleBlock>
              <SettingsToggleBlock
                title={
                  props.lang === "zh" ? "低额度切号" : props.lang === "zh-hant" ? "低額度切換" : "Low-quota switching"
                }
                sub={
                  props.lang === "zh"
                    ? "低额度、实际耗尽和 usageLimitExceeded 的自动切号。"
                    : props.lang === "zh-hant"
                      ? "低額度、實際耗盡和 usageLimitExceeded 的自動切換。"
                      : "Automatic switching for low quota, exhaustion, and usageLimitExceeded."
                }
                enabled={props.settings.seamlessSwitchLowQuotaEnabled}
                onToggle={(enabled) => patchAndSend("seamlessSwitchLowQuotaEnabled", enabled)}
              >
                <div class={`settings-stack ${props.settings.seamlessSwitchLowQuotaEnabled ? "" : "is-hidden"}`}>
                  <SettingsSegmentBlock
                    title={
                      props.lang === "zh"
                        ? "低额度阈值"
                        : props.lang === "zh-hant"
                          ? "低額度閾值"
                          : "Low-quota threshold"
                    }
                    sub={
                      props.lang === "zh"
                        ? "选择何时启动切换。"
                        : props.lang === "zh-hant"
                          ? "選擇何時啟動切換。"
                          : "Choose when to start switching."
                    }
                    options={([0, 1, 3, 5] as const).map((threshold) => ({
                      key: `switch-threshold-${threshold}`,
                      title:
                        threshold === 0
                          ? props.lang === "zh"
                            ? "耗尽后切换"
                            : props.lang === "zh-hant"
                              ? "耗盡後切換"
                              : "After exhaustion"
                          : `${threshold}%${threshold === 3 ? (props.lang === "zh" ? "（默认）" : props.lang === "zh-hant" ? "（預設）" : " (default)") : ""}`,
                      description:
                        props.lang === "zh"
                          ? threshold === 0
                            ? "全部活动会话耗尽后，最多观察 6 小时"
                            : threshold === 1
                              ? "尽量用尽额度"
                              : threshold === 3
                                ? "推荐"
                                : "保护长会话"
                          : props.lang === "zh-hant"
                            ? threshold === 0
                              ? "全部活動對話耗盡後，最多觀察 6 小時"
                              : threshold === 1
                                ? "盡量用盡額度"
                                : threshold === 3
                                  ? "建議"
                                  : "保護長對話"
                            : threshold === 0
                              ? "After all active turns exhaust, observe for up to 6 hours"
                              : threshold === 1
                                ? "Use as much quota as possible"
                                : threshold === 3
                                  ? "Recommended"
                                  : "Protect long turns",
                      active: props.settings.seamlessSwitchThreshold === threshold,
                      onClick: () => patchAndSend("seamlessSwitchThreshold", threshold)
                    }))}
                  />
                </div>
              </SettingsToggleBlock>
              <SettingsSegmentBlock
                title={props.lang === "zh" ? "切换策略" : props.lang === "zh-hant" ? "切換策略" : "Switch policy"}
                sub={
                  props.lang === "zh"
                    ? "切号时仍在运行的普通会话如何处理；Goal 会自动暂停并恢复。"
                    : props.lang === "zh-hant"
                      ? "切換時仍在執行的一般對話如何處理；Goal 會自動暫停並恢復。"
                      : "How to handle ordinary turns still running during a switch; Goals pause and resume automatically."
                }
                note={
                  props.lang === "zh"
                    ? `${props.settings.hotSwitchEnabled ? "Runtime 已安装。" : "Runtime 未安装，切号会安全跳过。"} 安装或移除请使用命令面板。`
                    : props.lang === "zh-hant"
                      ? `${props.settings.hotSwitchEnabled ? "Runtime 已安裝。" : "Runtime 未安裝，切換會安全略過。"} 安裝或移除請使用命令面板。`
                      : `${props.settings.hotSwitchEnabled ? "Runtime installed." : "Runtime not installed; switching fails closed."} Use the Command Palette to install or remove it.`
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
