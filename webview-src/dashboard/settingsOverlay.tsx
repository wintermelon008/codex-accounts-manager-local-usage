import type {
  DashboardCopy,
  DashboardIntegrationSettingViewModel,
  DashboardSettingKey,
  DashboardSettingValue,
  DashboardSettings,
  DashboardSeamlessRuntimeViewModel,
  DashboardState
} from "../../src/domain/dashboard/types";
import { useState } from "preact/hooks";
import { DASHBOARD_LOCAL_USAGE_RANGE_OPTIONS as LOCAL_USAGE_RANGE_OPTIONS } from "../../src/domain/dashboard/types";
import {
  SettingsDiscreteSlider,
  SettingsLanguageBlock,
  SettingsProxyBlock,
  SettingsSegmentBlock,
  SettingsThemeBlock,
  SettingsThresholdBlock,
  SettingsToggleBlock
} from "./components";
import { formatTemplate, formatTimestamp } from "./helpers";
import { CodeIcon } from "./icons";

const AUTO_REFRESH_VALUES = Array.from({ length: 60 }, (_, index) => index + 1);
const AUTO_REFRESH_SCALE_VALUES = [1, 15, 30, 45, 60];
const HOT_SWITCH_GRACE_VALUES = [10, 30, 60, 90, 120, 180, 300];
const WARNING_VALUES = Array.from({ length: 18 }, (_, index) => 5 + index * 5);
const WARNING_SCALE_VALUES = [5, 20, 35, 50, 65, 80, 90];
type SettingsSectionId = "base" | "operations" | "switching" | "quota" | "advanced";

function resolveSettingsSectionLabels(lang: DashboardState["lang"]): Array<{
  id: SettingsSectionId;
  title: string;
  sub: string;
}> {
  if (lang === "zh") {
    return [
      { id: "base", title: "基础设置", sub: "外观、用量与连接" },
      { id: "operations", title: "运维与集成", sub: "Manager 状态、功能选择与集成控制" },
      { id: "switching", title: "账号切换", sub: "无感切号与账号选项" },
      { id: "quota", title: "配额自动化", sub: "刷新、倒计时、提醒与颜色" },
      { id: "advanced", title: "高级与诊断", sub: "低频配置与调试" }
    ];
  }
  if (lang === "zh-hant") {
    return [
      { id: "base", title: "基礎設定", sub: "外觀、用量與連線" },
      { id: "operations", title: "維運與整合", sub: "Manager 狀態、功能選擇與整合控制" },
      { id: "switching", title: "帳號切換", sub: "無感切換與帳號選項" },
      { id: "quota", title: "配額自動化", sub: "重新整理、倒數、警示與顏色" },
      { id: "advanced", title: "進階與診斷", sub: "低頻設定與除錯" }
    ];
  }
  return [
    { id: "base", title: "Basics", sub: "Appearance, usage, and connection" },
    {
      id: "operations",
      title: "Operations & integrations",
      sub: "Manager status, feature selection, and integration controls"
    },
    { id: "switching", title: "Account switching", sub: "Seamless switching and account options" },
    { id: "quota", title: "Quota automation", sub: "Refresh, countdown, alerts, and colors" },
    { id: "advanced", title: "Advanced and diagnostics", sub: "Low-frequency settings and debug" }
  ];
}

function resolveSettingsSectionNavLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return "设置分类";
  }
  if (lang === "zh-hant") {
    return "設定分類";
  }
  return "Settings sections";
}

function resolveOpenSettingsJsonLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return "打开 settings.json";
  }
  if (lang === "zh-hant") {
    return "開啟 settings.json";
  }
  return "Open settings.json";
}

function resolveSettingsCloseLabel(lang: DashboardState["lang"]): string {
  if (lang === "zh") {
    return "关闭设置";
  }
  if (lang === "zh-hant") {
    return "關閉設定";
  }
  return "Close settings";
}

function resolveAdvancedAppearanceCopy(lang: DashboardState["lang"]): {
  title: string;
  sub: string;
  enabled: string;
  disabled: string;
} {
  if (lang === "zh") {
    return {
      title: "高级外观",
      sub: "启用 Command Center 风格的 Dashboard 视觉布局。",
      enabled: "已开启：仅改变外观与只读总览，账号数据和核心操作保持一致。",
      disabled: "已关闭：使用标准 Dashboard 外观。"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "進階外觀",
      sub: "啟用 Command Center 風格的 Dashboard 視覺佈局。",
      enabled: "已開啟：只改變外觀與唯讀總覽，帳號資料和核心操作保持一致。",
      disabled: "已關閉：使用標準 Dashboard 外觀。"
    };
  }
  return {
    title: "Advanced appearance",
    sub: "Use the Command Center visual layout for the Dashboard.",
    enabled:
      "Enabled: changes the appearance and read-only overview only; account data and core actions stay equivalent.",
    disabled: "Disabled: use the standard Dashboard appearance."
  };
}

function resolveQuotaCountdownAutoStartCopy(lang: DashboardState["lang"]): {
  title: string;
  sub: string;
  onDesc: string;
  offDesc: string;
} {
  if (lang === "zh") {
    return {
      title: "自动启动额度倒计时",
      sub: "额度窗口恢复后自动发送一次短对话，重新启动额度倒计时。",
      onDesc: "已开启：额度刷新后会自动发送一次短对话启动倒计时。",
      offDesc: "已关闭：额度到期后只刷新额度，不自动发送短对话。"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "自動啟動配額倒數",
      sub: "配額視窗恢復後自動發送一次短對話，重新啟動配額倒數。",
      onDesc: "已開啟：配額重新整理後會自動發送一次短對話啟動倒數。",
      offDesc: "已關閉：配額到期後只重新整理配額，不會自動發送短對話。"
    };
  }
  return {
    title: "Automatic quota countdown start",
    sub: "Send one short conversation after a quota window resets to start the next countdown.",
    onDesc: "Enabled: a short conversation starts the countdown after the quota refresh.",
    offDesc: "Disabled: expired quotas are refreshed without sending a conversation."
  };
}

function resolveOperationsCopy(lang: DashboardState["lang"]): {
  featuresTitle: string;
  featuresSub: string;
} {
  if (lang === "zh") {
    return {
      featuresTitle: "功能选择",
      featuresSub: "集中启用或停用由 Manager 集成提供的功能入口。"
    };
  }
  if (lang === "zh-hant") {
    return {
      featuresTitle: "功能選擇",
      featuresSub: "集中啟用或停用由 Manager 整合提供的功能入口。"
    };
  }
  return {
    featuresTitle: "Feature selection",
    featuresSub: "Enable or disable feature entry points provided by Manager integrations."
  };
}

export function SettingsOverlay(props: {
  open: boolean;
  copy: DashboardCopy;
  lang: DashboardState["lang"];
  settings: DashboardSettings;
  tokenAutomation: DashboardState["tokenAutomation"];
  integrationSettings: readonly DashboardIntegrationSettingViewModel[];
  seamlessRuntime?: DashboardSeamlessRuntimeViewModel;
  onClose: () => void;
  onPatchSettings: (patch: Partial<DashboardSettings>) => void;
  onSendSetting: (key: DashboardSettingKey, value: DashboardSettingValue) => void;
  onAutoRefreshToggle: (enabled: boolean) => void;
  onAutoRefreshValue: (minutes: number) => void;
  onThresholdPreview: (key: "yellow" | "green", value: number) => void;
  onThresholdCommit: (key: "yellow" | "green", value: number) => void;
  onOpenSettingsJson: () => void;
  onIntegrationSettingToggle: (settingId: string, enabled: boolean) => void;
  onResetSeamlessSwitchRuntime: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("base");
  const patchAndSend = (key: DashboardSettingKey, value: DashboardSettingValue) => {
    props.onPatchSettings({ [key]: value } as Partial<DashboardSettings>);
    props.onSendSetting(key, value);
  };
  const quotaCountdownAutoStartCopy = resolveQuotaCountdownAutoStartCopy(props.lang);
  const operationsCopy = resolveOperationsCopy(props.lang);

  const toggleUsageRange = (range: (typeof LOCAL_USAGE_RANGE_OPTIONS)[number]): void => {
    const enabled = new Set(props.settings.localUsageEnabledRanges);
    if (enabled.has(range)) {
      enabled.delete(range);
    } else {
      enabled.add(range);
    }
    const next = LOCAL_USAGE_RANGE_OPTIONS.filter((candidate) => enabled.has(candidate));
    patchAndSend("localUsageEnabledRanges", next.length > 0 ? next : ["24h"]);
  };

  const sectionLabels = resolveSettingsSectionLabels(props.lang);
  const openSettingsJsonLabel = resolveOpenSettingsJsonLabel(props.lang);
  const advancedAppearanceCopy = resolveAdvancedAppearanceCopy(props.lang);

  return (
    <div class={`overlay ${props.open ? "open" : ""}`} onClick={props.onClose}>
      <div class="settings-modal settings-modal-organized" onClick={(event) => event.stopPropagation()}>
        <div class="settings-modal-head">
          <div class="settings-modal-title">{props.copy.settingsTitle}</div>
          <div class="settings-modal-head-actions">
            <button
              class="settings-open-json-btn"
              type="button"
              title={openSettingsJsonLabel}
              aria-label={openSettingsJsonLabel}
              onClick={props.onOpenSettingsJson}
            >
              <CodeIcon />
              <span>{openSettingsJsonLabel}</span>
            </button>
            <button
              class="settings-close"
              type="button"
              aria-label={resolveSettingsCloseLabel(props.lang)}
              onClick={props.onClose}
            >
              ×
            </button>
          </div>
        </div>
        <div class="settings-modal-body">
          <div class="settings-layout">
            <nav class="settings-section-nav" aria-label={resolveSettingsSectionNavLabel(props.lang)}>
              {sectionLabels.map((section) => (
                <button
                  key={section.id}
                  class={`settings-section-tab ${activeSection === section.id ? "active" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === section.id}
                  aria-controls={`settings-section-${section.id}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <span class="settings-section-tab-title">{section.title}</span>
                  <span class="settings-section-tab-sub">{section.sub}</span>
                </button>
              ))}
            </nav>
            <div class="settings-section-content">
              {activeSection === "base" ? (
                <section id="settings-section-base" class="settings-section-panel" role="tabpanel">
                  <SettingsThemeBlock
                    lang={props.lang}
                    settings={props.settings}
                    onChange={(value) => {
                      props.onPatchSettings({ dashboardTheme: value });
                      props.onSendSetting("dashboardTheme", value);
                    }}
                  />
                  <SettingsToggleBlock
                    title={advancedAppearanceCopy.title}
                    sub={advancedAppearanceCopy.sub}
                    enabled={props.settings.advancedAppearanceEnabled}
                    onToggle={(enabled) => patchAndSend("advancedAppearanceEnabled", enabled)}
                  >
                    <div class="settings-note">
                      {props.settings.advancedAppearanceEnabled
                        ? advancedAppearanceCopy.enabled
                        : advancedAppearanceCopy.disabled}
                    </div>
                  </SettingsToggleBlock>
                  <SettingsLanguageBlock
                    copy={props.copy}
                    settings={props.settings}
                    onChange={(value) => {
                      props.onPatchSettings({ displayLanguage: value });
                      props.onSendSetting("displayLanguage", value);
                    }}
                  />
                  <SettingsProxyBlock
                    copy={props.copy}
                    settings={props.settings}
                    onChange={(value) => patchAndSend("proxyAddress", value)}
                  />
                  <SettingsSegmentBlock
                    title={props.copy.localUsageSettingsTitle}
                    sub={props.copy.localUsageSettingsSub}
                    options={[
                      {
                        key: "local-usage-24h",
                        title: props.copy.localUsageRange24Hours,
                        description: props.copy.localUsageRange24HoursDesc,
                        active: props.settings.localUsageEnabledRanges.includes("24h"),
                        onClick: () => toggleUsageRange("24h")
                      },
                      {
                        key: "local-usage-3d",
                        title: props.copy.localUsageRange3Days,
                        description: props.copy.localUsageRange3DaysDesc,
                        active: props.settings.localUsageEnabledRanges.includes("3d"),
                        onClick: () => toggleUsageRange("3d")
                      },
                      {
                        key: "local-usage-7d",
                        title: props.copy.localUsageRange7Days,
                        description: props.copy.localUsageRange7DaysDesc,
                        active: props.settings.localUsageEnabledRanges.includes("7d"),
                        onClick: () => toggleUsageRange("7d")
                      },
                      {
                        key: "local-usage-14d",
                        title: props.copy.localUsageRange14Days,
                        description: props.copy.localUsageRange14DaysDesc,
                        active: props.settings.localUsageEnabledRanges.includes("14d"),
                        onClick: () => toggleUsageRange("14d")
                      },
                      {
                        key: "local-usage-7w",
                        title: props.copy.localUsageRange7Weeks,
                        description: props.copy.localUsageRange7WeeksDesc,
                        active: props.settings.localUsageEnabledRanges.includes("7w"),
                        onClick: () => toggleUsageRange("7w")
                      },
                      {
                        key: "local-usage-7m",
                        title: props.copy.localUsageRange7Months,
                        description: props.copy.localUsageRange7MonthsDesc,
                        active: props.settings.localUsageEnabledRanges.includes("7m"),
                        onClick: () => toggleUsageRange("7m")
                      }
                    ]}
                    note={props.copy.localUsageEnabledRangesSub}
                  />
                  <SettingsToggleBlock
                    title={props.copy.localUsagePriceSettingsTitle}
                    sub={props.copy.localUsagePriceSettingsSub}
                    enabled={props.settings.localUsageShowEquivalentPrice}
                    onToggle={(enabled) => patchAndSend("localUsageShowEquivalentPrice", enabled)}
                  >
                    <div class="settings-note">{props.copy.localUsagePriceSettingsNote}</div>
                  </SettingsToggleBlock>
                </section>
              ) : null}
              {activeSection === "operations" ? (
                <section id="settings-section-operations" class="settings-section-panel" role="tabpanel">
                  <SeamlessRuntimeStatus
                    runtime={props.seamlessRuntime}
                    featureEnabled={props.settings.seamlessSwitchEnabled}
                    lang={props.lang}
                  />
                  <div class="settings-subsection-heading">
                    <div class="settings-block-title">{operationsCopy.featuresTitle}</div>
                    <div class="settings-block-sub">{operationsCopy.featuresSub}</div>
                  </div>
                  {props.integrationSettings.map((setting) => (
                    <SettingsToggleBlock
                      key={setting.id}
                      title={setting.title}
                      sub={setting.description ?? ""}
                      enabled={setting.enabled}
                      onToggle={(enabled) => props.onIntegrationSettingToggle(setting.id, enabled)}
                    />
                  ))}
                </section>
              ) : null}
              {activeSection === "switching" ? (
                <section id="settings-section-switching" class="settings-section-panel" role="tabpanel">
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
                            ? "低额度切号"
                            : props.lang === "zh-hant"
                              ? "低額度切換"
                              : "Low-quota switching"
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
                        <div
                          class={`settings-stack ${props.settings.seamlessSwitchLowQuotaEnabled ? "" : "is-hidden"}`}
                        >
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
                        title={
                          props.lang === "zh" ? "切换策略" : props.lang === "zh-hant" ? "切換策略" : "Switch policy"
                        }
                        sub={
                          props.lang === "zh"
                            ? "切号时仍在运行的普通会话如何处理；Goal 会自动暂停并恢复。"
                            : props.lang === "zh-hant"
                              ? "切換時仍在執行的一般對話如何處理；Goal 會自動暫停並恢復。"
                              : "How to handle ordinary turns still running during a switch; Goals pause and resume automatically."
                        }
                        note={
                          props.lang === "zh"
                            ? `${props.settings.hotSwitchEnabled ? "Runtime 已安装。" : "Runtime 未安装，切号会安全跳过。"} 下方开关只控制无感切号行为。`
                            : props.lang === "zh-hant"
                              ? `${props.settings.hotSwitchEnabled ? "Runtime 已安裝。" : "Runtime 未安裝，切換會安全略過。"} 下方開關只控制無感切換行為。`
                              : `${props.settings.hotSwitchEnabled ? "Runtime installed." : "Runtime not installed; switching fails closed."} The toggle below controls seamless-switch behavior only.`
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
                      <div class="settings-block">
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
                    </div>
                    <div class="settings-note">
                      {props.lang === "zh"
                        ? "清除额度基线、低额度观测和待重试状态；会同步实际 provider 路由，并只回收没有真实 app-server 子进程的孤儿 runtime。"
                        : props.lang === "zh-hant"
                          ? "清除額度基線、低額度觀測和待重試狀態；會同步實際 provider 路由，並只回收沒有真實 app-server 子程序的孤兒 runtime。"
                          : "Clear quota baselines, low-quota observations, and pending retries; reconcile the live provider route and reap only orphan runtimes without a real app-server child."}
                    </div>
                    <div class="saved-actions settings-inline-actions">
                      <button type="button" onClick={props.onResetSeamlessSwitchRuntime}>
                        {props.lang === "zh"
                          ? "复位无感切号状态"
                          : props.lang === "zh-hant"
                            ? "重設無感切換狀態"
                            : "Reset seamless-switch state"}
                      </button>
                    </div>
                  </SettingsToggleBlock>
                </section>
              ) : null}
              {activeSection === "quota" ? (
                <section id="settings-section-quota" class="settings-section-panel" role="tabpanel">
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
                    title={props.copy.quotaCountdownAutoStartTitle ?? quotaCountdownAutoStartCopy.title}
                    sub={props.copy.quotaCountdownAutoStartSub ?? quotaCountdownAutoStartCopy.sub}
                    enabled={props.settings.autoStartQuotaCountdownEnabled}
                    onToggle={(enabled) => patchAndSend("autoStartQuotaCountdownEnabled", enabled)}
                  >
                    <div class="settings-note">
                      {props.settings.autoStartQuotaCountdownEnabled
                        ? props.copy.quotaCountdownAutoStartOnDesc ?? quotaCountdownAutoStartCopy.onDesc
                        : props.copy.quotaCountdownAutoStartOffDesc ?? quotaCountdownAutoStartCopy.offDesc}
                    </div>
                  </SettingsToggleBlock>
                  <SettingsToggleBlock
                    title={props.copy.warningTitle}
                    sub={
                      props.settings.hourlyQuotaControlEnabled ? props.copy.warningSub : props.copy.warningWeeklyOnlySub
                    }
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
                </section>
              ) : null}
              {activeSection === "advanced" ? (
                <section id="settings-section-advanced" class="settings-section-panel" role="tabpanel">
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
                </section>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SeamlessRuntimeStatus(props: {
  runtime?: DashboardSeamlessRuntimeViewModel;
  featureEnabled: boolean;
  lang: DashboardState["lang"];
}) {
  const runtime = props.runtime;
  const state = runtime?.state ?? (props.featureEnabled ? "starting" : "disabled");
  const labels = resolveSeamlessRuntimeLabels(props.lang);
  const stateLabel = resolveSeamlessRuntimeStateLabel(state, props.lang, props.featureEnabled);
  const message = resolveSeamlessRuntimeMessage(state, props.lang, props.featureEnabled, runtime?.failureReason);
  const protocol = runtime
    ? `${runtime.runtimeProtocolVersion ?? "—"} / ${runtime.expectedRuntimeProtocolVersion ?? "—"}`
    : "—";
  const provider = runtime?.providerKind ?? "—";
  const attribution = runtime?.attributionActive
    ? labels.attributionActive
    : state === "degraded"
      ? labels.attributionFailed
      : labels.attributionInactive;
  return (
    <div class={`seamless-runtime-status seamless-runtime-status-${state}`}>
      <div class="seamless-runtime-status-head">
        <div>
          <div class="settings-block-title">{labels.title}</div>
          <div class="settings-block-sub">{message}</div>
        </div>
        <strong>{stateLabel}</strong>
      </div>
      <div class="seamless-runtime-status-details">
        <div>
          <span>{labels.protocol}</span>
          <strong>{protocol}</strong>
        </div>
        <div>
          <span>{labels.provider}</span>
          <strong>{provider}</strong>
        </div>
        <div>
          <span>{labels.activeTurns}</span>
          <strong>{runtime?.activeTurns ?? 0}</strong>
        </div>
        <div>
          <span>{labels.attribution}</span>
          <strong>{attribution}</strong>
        </div>
        <div>
          <span>{labels.checkedAt}</span>
          <strong>{formatTimestamp(runtime?.checkedAt, labels.notChecked)}</strong>
        </div>
      </div>
      {runtime?.attributionFailureReason ? (
        <div class="seamless-runtime-status-reason" title={runtime.attributionFailureReason}>
          {runtime.attributionFailureReason}
        </div>
      ) : null}
    </div>
  );
}

function resolveSeamlessRuntimeLabels(lang: DashboardState["lang"]) {
  if (lang === "zh") {
    return {
      title: "无感 Runtime 状态",
      protocol: "协议",
      provider: "路由",
      activeTurns: "活动会话",
      attribution: "用量归因",
      checkedAt: "最近检查",
      notChecked: "尚未检查",
      attributionActive: "已启用",
      attributionFailed: "失败",
      attributionInactive: "未启用"
    };
  }
  if (lang === "zh-hant") {
    return {
      title: "無感 Runtime 狀態",
      protocol: "協議",
      provider: "路由",
      activeTurns: "活動對話",
      attribution: "用量歸因",
      checkedAt: "最近檢查",
      notChecked: "尚未檢查",
      attributionActive: "已啟用",
      attributionFailed: "失敗",
      attributionInactive: "未啟用"
    };
  }
  return {
    title: "Seamless runtime status",
    protocol: "Protocol",
    provider: "Route",
    activeTurns: "Active turns",
    attribution: "Usage attribution",
    checkedAt: "Last check",
    notChecked: "Not checked",
    attributionActive: "Active",
    attributionFailed: "Failed",
    attributionInactive: "Inactive"
  };
}

function resolveSeamlessRuntimeStateLabel(
  state: NonNullable<DashboardSeamlessRuntimeViewModel>["state"],
  lang: DashboardState["lang"],
  featureEnabled: boolean
): string {
  const labels =
    lang === "zh"
      ? {
          disabled: "未启用",
          ready: "已就绪",
          needs_reload: "需要 reload",
          starting: "启动中",
          degraded: "部分可用",
          unavailable: "不可用"
        }
      : lang === "zh-hant"
        ? {
            disabled: "未啟用",
            ready: "已就緒",
            needs_reload: "需要 reload",
            starting: "啟動中",
            degraded: "部分可用",
            unavailable: "不可用"
          }
        : {
            disabled: "Disabled",
            ready: "Ready",
            needs_reload: "Reload required",
            starting: "Starting",
            degraded: "Degraded",
            unavailable: "Unavailable"
          };
  if (state === "ready" && !featureEnabled) {
    return lang === "zh" ? "已就绪 · 功能关闭" : lang === "zh-hant" ? "已就緒 · 功能關閉" : "Ready · feature off";
  }
  return labels[state];
}

function resolveSeamlessRuntimeMessage(
  state: NonNullable<DashboardSeamlessRuntimeViewModel>["state"],
  lang: DashboardState["lang"],
  featureEnabled: boolean,
  failureReason?: string
): string {
  if (state === "ready" && !featureEnabled) {
    return lang === "zh"
      ? "Runtime 正常，但无感切号开关当前关闭。"
      : lang === "zh-hant"
        ? "Runtime 正常，但無感切換開關目前關閉。"
        : "The runtime is healthy, but seamless switching is currently disabled.";
  }
  switch (state) {
    case "disabled":
      return lang === "zh"
        ? "当前未启用 Runtime；无感切号会安全跳过。"
        : lang === "zh-hant"
          ? "目前未啟用 Runtime；無感切換會安全略過。"
          : "The runtime is not enabled; seamless switching will fail closed.";
    case "needs_reload":
      return lang === "zh"
        ? "Runtime 已安装或配置已变化，请 reload 一次后再切号。"
        : lang === "zh-hant"
          ? "Runtime 已安裝或設定已變更，請 reload 一次後再切換。"
          : "The runtime was installed or changed; reload once before switching.";
    case "starting":
      return lang === "zh"
        ? "正在等待 Codex app-server 响应，切号会暂时安全跳过。"
        : lang === "zh-hant"
          ? "正在等待 Codex app-server 回應，切換會暫時安全略過。"
          : "Waiting for the Codex app-server; switching will fail closed for now.";
    case "degraded":
      return lang === "zh"
        ? "Runtime 可以切号，但本机用量归因尚未激活。"
        : lang === "zh-hant"
          ? "Runtime 可以切換，但本機用量歸因尚未啟用。"
          : "The runtime can switch accounts, but local usage attribution is inactive.";
    case "unavailable":
      return (
        failureReason ??
        (lang === "zh"
          ? "Runtime 当前不可用。"
          : lang === "zh-hant"
            ? "Runtime 目前不可用。"
            : "The runtime is currently unavailable.")
      );
    case "ready":
      return lang === "zh"
        ? "Runtime 已连接，可执行无感切号。"
        : lang === "zh-hant"
          ? "Runtime 已連線，可以執行無感切換。"
          : "The runtime is connected and ready for seamless switching.";
  }
}
