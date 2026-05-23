import { useEffect, useMemo, useRef, useState } from "react";
import { aggregateCandles, normalizeChartInterval, type ChartInterval } from "../data/candleAggregation";
import {
  loadDashboardMarketData,
  loadDashboardResults,
  loadDailyOperationMarketData,
  loadDailyPaperResults,
  loadSampleMarketData,
  type DashboardMarketData,
  type DashboardResults,
  type DailyPaperResult,
  type DailyPaperResultsPayload,
} from "../data/marketData";
import { loadWsLiveResults, type WsLiveResults } from "../data/wsLiveData";
import { defaultBacktestConfig } from "../simulation/backtest";
import { decideDailyOperation, scoreSignal, type DailySignal } from "../simulation/dailyOperation";
import {
  compareStrategies,
  compareStrategiesByGuideMode,
  type StrategyComparison,
  type StrategyGuideModeComparison,
} from "../simulation/optimizer";
import { buildTraderOptimizationPlans, type TraderOptimizationPlan } from "../simulation/traderOptimization";
import { strategies } from "../strategies";
import { traderProfiles } from "../traders/profiles";
import type { BacktestResult, BlockedSignal, Candle, GuideRuleMode, SafetyMode, Trade, TraderId } from "../types/trading";
import { MarketChart } from "../ui/MarketChart";

type ThemeMode = "light" | "dark";
type AutoBlockMode = SafetyMode;
type ScreenId =
  | "scenario-anomaly"
  | "scenario-guideline"
  | "report-summary"
  | "report-anomaly"
  | "daily-general-a"
  | "daily-general-b"
  | "daily-general-c"
  | "daily-anomaly";
type PopupTab = "graph" | "trades" | "returns" | "balance";
type OperationPopupTab = Exclude<PopupTab, "graph">;
type GuideFilterMode = GuideRuleMode | "all";
type SafetyFilterMode = AutoBlockMode | "all";
const screenStorageKey = "crypto-trading.screenId";
const screenIds: ScreenId[] = [
  "scenario-anomaly",
  "scenario-guideline",
  "report-summary",
  "report-anomaly",
  "daily-general-a",
  "daily-general-b",
  "daily-general-c",
  "daily-anomaly",
];

type PopupState =
  | { blockedSignals: BlockedSignal[]; currentReturn: number; dayStartMs: number | undefined; kind: "market"; market: string; tradeSummary: TradeSummary; trades: Trade[] }
  | {
      autoBlockMode: AutoBlockMode;
      guideMode: GuideRuleMode;
      kind: "operation";
      plan: TraderOptimizationPlan | undefined;
      tab: OperationPopupTab;
      title: string;
      traderId: TraderId;
    };

interface AutoBlockEvaluation {
  blocked: boolean;
  reasons: string[];
}

interface OperationCaseResult {
  autoBlockMode: AutoBlockMode;
  color: string;
  equityCurve: Array<{ timestamp: number; value: number }>;
  guideMode: GuideRuleMode;
  initialCash: number;
  label: string;
  trades: Trade[];
}

interface DisplayTrade extends Trade {
  caseLabel?: string;
}

interface DailyEntry {
  autoBlock: AutoBlockEvaluation;
  blockedSignals: BlockedSignal[];
  blockedBuyCount: number;
  candles: Candle[];      // all candles including pre-midnight (for chart)
  dayStartMs: number;     // KST midnight timestamp (for midnight line)
  currentReturn: number;
  label: string;
  market: string;
  paperReturn: number;
  rawTrades: Trade[];
  result: BacktestResult;
  signal: DailySignal;
  tradeSummary: TradeSummary;
  trades: Trade[];
}

interface TradeSummary {
  blocked: number;
  buys: number;
  returnRate: number;
  sells: number;
}

interface CaseMetric {
  autoBlockMode: AutoBlockMode;
  blocked: number;
  guideMode: GuideRuleMode;
  label: string;
  maxDrawdown: number;
  returnRate: number;
  trades: number;
}

interface CaseComparisonRow {
  bestCase: CaseMetric;
  cases: CaseMetric[];
  strategyName: string;
}

interface StrategyRefreshStatus {
  completedAt: string;
  error: string;
  logs: string[];
  progress: number;
  running: boolean;
  scope?: "general" | "anomaly" | "idle";
  stepIndex: number;
  stepLabel: string;
  totalSteps: number;
}

interface MenuSection {
  title: string;
  items: Array<{ id: ScreenId; label: string; caption?: string }>;
}

const formatPct = (value: number) => `${(value * 100).toFixed(2)}%`;
const formatScore = (value: number) => `${Math.round(value * 100)}`;
const formatKrw = (value: number) =>
  new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
const formatCompactKrw = (value: number) =>
  new Intl.NumberFormat("ko-KR", {
    notation: "compact",
    maximumFractionDigits: 1,
    style: "currency",
    currency: "KRW",
  }).format(value);

const chartIntervalPresets: Array<{ interval: ChartInterval; label: string; value: string; windowLabel: string }> = [
  { interval: { value: 1, unit: "minute" }, label: "1 minute", value: "1m", windowLabel: "6 hours" },
  { interval: { value: 5, unit: "minute" }, label: "5 minutes", value: "5m", windowLabel: "1 day" },
  { interval: { value: 30, unit: "minute" }, label: "30 minutes", value: "30m", windowLabel: "1 week" },
  { interval: { value: 1, unit: "hour" }, label: "1 hour", value: "1h", windowLabel: "1 month" },
];

const menuSections: MenuSection[] = [
  {
    title: "전략 개요",
    items: [
      { id: "scenario-anomaly", label: "특이점 전략 A/B/C/D", caption: "진입 조건 / 파라미터" },
      { id: "scenario-guideline", label: "리스크 가이드", caption: "Safety / Guideline" },
    ],
  },
  {
    title: "시뮬레이션 결과",
    items: [
      { id: "report-summary", label: "Summary" },
      { id: "report-anomaly", label: "전략 리포트 A/B/C/D" },
    ],
  },
  {
    title: "Daily 운영",
    items: [
      { id: "daily-general-a", label: "Anomaly-A", caption: "Calm Impulse" },
      { id: "daily-general-b", label: "Anomaly-B", caption: "First Explosion" },
      { id: "daily-general-c", label: "Anomaly-C", caption: "Confirmed Burst" },
      { id: "daily-anomaly", label: "Anomaly-D", caption: "Sweep Best" },
    ],
  },
];

const dailyScreens: Record<
  Extract<ScreenId, "daily-general-a" | "daily-general-b" | "daily-general-c" | "daily-anomaly">,
  { title: string; traderId: TraderId; description: string }
> = {
  "daily-general-a": {
    title: "Anomaly-A / Calm Impulse",
    traderId: "momentum",
    description: "15봉 조용한 구간 이후 첫 번째 충동적 상승을 포착합니다. 거래량 1.5× + 바디 1% 조건.",
  },
  "daily-general-b": {
    title: "Anomaly-B / First Explosion",
    traderId: "range-grid",
    description: "거래량 3.5× + 바디 2.5% 이상의 폭발적 상승 캔들 자체에 진입합니다.",
  },
  "daily-general-c": {
    title: "Anomaly-C / Confirmed Burst",
    traderId: "arbitrage",
    description: "폭발 캔들 다음 봉에서 거래량 1.8× + 상승 유지를 확인 후 진입합니다.",
  },
  "daily-anomaly": {
    title: "Anomaly-D / Sweep Best",
    traderId: "anomaly",
    description: "최적화된 trailingStop(0.018) 적용 베이스라인. 특이점 감시 전체 커버.",
  },
};

export function App() {
  const [screenId, setScreenId] = useState<ScreenId>(() => loadStoredScreenId());
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [chartInterval, setChartInterval] = useState<ChartInterval>({ value: 5, unit: "minute" });
  const [modalInterval, setModalInterval] = useState<ChartInterval>({ value: 5, unit: "minute" });
  const [reportGuideMode, setReportGuideMode] = useState<GuideRuleMode>("strict");
  const [reportAutoBlockMode, setReportAutoBlockMode] = useState<AutoBlockMode>("enabled");
  const [dailyGuideModes, setDailyGuideModes] = useState<Record<string, GuideRuleMode>>({
    "daily-general-a": "ignored",
    "daily-general-b": "ignored",
    "daily-general-c": "ignored",
    "daily-anomaly": "ignored",
  });
  const [dailyAutoBlockModes, setDailyAutoBlockModes] = useState<Record<string, AutoBlockMode>>({
    "daily-general-a": "enabled",
    "daily-general-b": "enabled",
    "daily-general-c": "enabled",
    "daily-anomaly": "enabled",
  });
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [marketData, setMarketData] = useState<DashboardMarketData>(() => loadSampleMarketData());
  const [dailyMarketData, setDailyMarketData] = useState<DashboardMarketData | null>(null);
  const [dailyPaperResults, setDailyPaperResults] = useState<DailyPaperResultsPayload | null>(null);
  const [dashboardResults, setDashboardResults] = useState<DashboardResults | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<StrategyRefreshStatus | null>(null);
  const [wsLiveResults, setWsLiveResults] = useState<WsLiveResults | null>(null);
  const [importNotice, setImportNotice] = useState("아직 import된 전략 파일이 없습니다.");
  const lastRefreshCompletedAtRef = useRef("");
  const lastDailyMarketGeneratedAtRef = useRef("");
  const lastDailyPaperGeneratedAtRef = useRef("");

  useEffect(() => {
    window.localStorage.setItem(screenStorageKey, screenId);
  }, [screenId]);

  useEffect(() => {
    let active = true;
    loadDashboardState().then(([nextMarketData, nextResults, nextDailyMarketData, nextDailyPaperResults]) => {
      if (!active) return;
      setMarketData(nextMarketData);
      setDashboardResults(nextResults);
      setDailyMarketData(nextDailyMarketData);
      setDailyPaperResults(nextDailyPaperResults);
      lastDailyMarketGeneratedAtRef.current = nextDailyMarketData?.generatedAt ?? "";
      lastDailyPaperGeneratedAtRef.current = nextDailyPaperResults?.generatedAt ?? "";
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function poll() {
      const status = await loadRefreshStatus();
      if (!active || !status) return;
      setRefreshStatus(status);

      if (
        status.completedAt &&
        status.completedAt !== lastRefreshCompletedAtRef.current &&
        !status.running &&
        !status.error
      ) {
        lastRefreshCompletedAtRef.current = status.completedAt;
        const [nextMarketData, nextResults, nextDailyMarketData, nextDailyPaperResults] = await loadDashboardState();
        if (!active) return;
        setMarketData(nextMarketData);
        setDashboardResults(nextResults);
        setDailyMarketData(nextDailyMarketData);
        setDailyPaperResults(nextDailyPaperResults);
        lastDailyMarketGeneratedAtRef.current = nextDailyMarketData?.generatedAt ?? "";
        lastDailyPaperGeneratedAtRef.current = nextDailyPaperResults?.generatedAt ?? "";
      }
    }

    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function pollDailyOperationState() {
      const [nextDailyMarketData, nextDailyPaperResults] = await loadDailyOperationState();
      if (!active) return;

      const nextMarketGeneratedAt = nextDailyMarketData?.generatedAt ?? "";
      const nextPaperGeneratedAt = nextDailyPaperResults?.generatedAt ?? "";

      if (nextMarketGeneratedAt && nextMarketGeneratedAt !== lastDailyMarketGeneratedAtRef.current) {
        lastDailyMarketGeneratedAtRef.current = nextMarketGeneratedAt;
        setDailyMarketData(nextDailyMarketData);
      }

      if (nextPaperGeneratedAt && nextPaperGeneratedAt !== lastDailyPaperGeneratedAtRef.current) {
        lastDailyPaperGeneratedAtRef.current = nextPaperGeneratedAt;
        setDailyPaperResults(nextDailyPaperResults);
      }
    }

    pollDailyOperationState();
    const timer = window.setInterval(pollDailyOperationState, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function pollWsLiveResults() {
      const result = await loadWsLiveResults();
      if (active) setWsLiveResults(result);
    }

    pollWsLiveResults();
    const timer = window.setInterval(pollWsLiveResults, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const comparisonsByMode = useMemo(
    () => ({
      strict:
        dashboardResults?.comparisonsByGuideMode?.strict ??
        dashboardResults?.comparisons ??
        compareStrategies(strategies, marketData.candlesByMarket, { ...defaultBacktestConfig, guideRuleMode: "strict" }),
      ignored:
        dashboardResults?.comparisonsByGuideMode?.ignored ??
        dashboardResults?.comparisons ??
        compareStrategies(strategies, marketData.candlesByMarket, { ...defaultBacktestConfig, guideRuleMode: "ignored" }),
    }),
    [dashboardResults, marketData],
  );
  const optimizationPlansByMode = useMemo(
    () => ({
      strict:
        dashboardResults?.optimizationPlansByGuideMode?.strict ??
        dashboardResults?.optimizationPlans ??
        buildTraderOptimizationPlans(strategies, marketData.candlesByMarket, {
          candidateMarketCount: 30,
          monitoringMarketCount: 9,
          guideRuleMode: "strict",
          config: { ...defaultBacktestConfig, guideRuleMode: "strict" },
        }),
      ignored:
        dashboardResults?.optimizationPlansByGuideMode?.ignored ??
        dashboardResults?.optimizationPlans ??
        buildTraderOptimizationPlans(strategies, marketData.candlesByMarket, {
          candidateMarketCount: 30,
          monitoringMarketCount: 9,
          guideRuleMode: "ignored",
          config: { ...defaultBacktestConfig, guideRuleMode: "ignored" },
        }),
    }),
    [dashboardResults, marketData],
  );
  const guideModeComparisons = useMemo(
    () =>
      dashboardResults?.guideModeComparisons ??
      compareStrategiesByGuideMode(strategies, marketData.candlesByMarket, defaultBacktestConfig),
    [dashboardResults, marketData],
  );

  const activeDailyScreen = isDailyScreenId(screenId) ? dailyScreens[screenId] : null;
  const isDailyScreen = activeDailyScreen !== null;
  const activeDailyGuideMode = activeDailyScreen ? dailyGuideModes[screenId] ?? "strict" : reportGuideMode;
  const activeDailyAutoBlockMode = activeDailyScreen ? dailyAutoBlockModes[screenId] ?? "enabled" : "enabled";
  const activeComparisons = comparisonsByMode[activeDailyGuideMode];
  const activeOptimizationPlans = optimizationPlansByMode[activeDailyGuideMode];
  const ranked = activeComparisons.slice().sort((a, b) => b.bestResult.returnRate - a.bestResult.returnRate);
  const operationMarketData = dailyMarketData ?? marketData;
  const activeDailyPaperResults = getDailyPaperCaseResults(dailyPaperResults, activeDailyGuideMode, activeDailyAutoBlockMode);
  const selectedMarketCandles = popup?.kind === "market"
    ? operationMarketData.candlesByMarket[popup.market] ?? marketData.candlesByMarket[popup.market] ?? []
    : [];

  function updateDailyGuideMode(mode: GuideRuleMode) {
    if (!isDailyScreen) return;
    updateSharedGuideMode(mode);
  }

  function updateSharedGuideMode(mode: GuideRuleMode) {
    setReportGuideMode(mode);
    setDailyGuideModes((current) => ({
      ...current,
      ...Object.fromEntries(Object.keys(dailyScreens).map((dailyScreenId) => [dailyScreenId, mode])),
    }));
  }

  function updateDailyAutoBlockMode(mode: AutoBlockMode) {
    if (!isDailyScreen) return;
    updateSharedAutoBlockMode(mode);
  }

  function updateSharedAutoBlockMode(mode: AutoBlockMode) {
    setReportAutoBlockMode(mode);
    setDailyAutoBlockModes((current) => ({
      ...current,
      ...Object.fromEntries(Object.keys(dailyScreens).map((dailyScreenId) => [dailyScreenId, mode])),
    }));
  }

  function openMarketPopup(market: string, trades: Trade[], blockedSignals: BlockedSignal[], currentReturn: number, tradeSummary: TradeSummary, dayStartMs: number | undefined) {
    setPopup({ blockedSignals, currentReturn, dayStartMs, kind: "market", market, tradeSummary, trades });
    setModalInterval(chartInterval);
  }

  function openOperationPopup(
    screen: { title: string; traderId: TraderId },
    plan: TraderOptimizationPlan | undefined,
    guideMode: GuideRuleMode,
    autoBlockMode: AutoBlockMode,
    tab: OperationPopupTab,
  ) {
    setPopup({
      autoBlockMode,
      guideMode,
      kind: "operation",
      plan,
      tab,
      title: screen.title,
      traderId: screen.traderId,
    });
  }

  async function handleStrategyRefresh(scope: "general" | "anomaly") {
    const response = await fetch(`/api/strategy-refresh?scope=${scope}`, { method: "POST" });
    const status = (await response.json()) as StrategyRefreshStatus;
    setRefreshStatus(status);
  }

  function handleImport(file: File | undefined, scope: string) {
    if (!file) return;
    setImportNotice(`${scope}: ${file.name} 파일을 읽었습니다. 검증과 실제 적용 로직은 다음 단계에서 연결할 예정입니다.`);
  }

  return (
    <main className="app-shell" data-theme={themeMode}>
      <aside className="sidebar" aria-label="Main menu">
        <div className="brand-block">
          <p className="eyebrow">Upbit KRW Simulation Lab</p>
          <h1>Anomaly Lab</h1>
          <span>{marketData.isRealUpbitData ? "Upbit Cached" : "Sample Only"}</span>
        </div>
        <nav className="menu">
          {menuSections.map((section) => (
            <section className="menu-section" key={section.title}>
              <h2>{section.title}</h2>
              {section.items.map((item) => (
                <button
                  className={screenId === item.id ? "menu-item active" : "menu-item"}
                  key={item.id}
                  onClick={() => setScreenId(item.id)}
                  type="button"
                >
                  <span>{item.label}</span>
                  {item.caption ? <small>{item.caption}</small> : null}
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="workspace-topbar">
          <div>
            <p className="eyebrow">{getScreenKicker(screenId)}</p>
            <h2>{getScreenTitle(screenId)}</h2>
          </div>
          <div className="top-actions">
            <button
              className="utility-button"
              onClick={() => setThemeMode((current) => (current === "light" ? "dark" : "light"))}
              type="button"
            >
              {themeMode === "light" ? "Dark" : "Light"}
            </button>
            <button
              className="utility-button"
              disabled={refreshStatus?.running}
              onClick={() => handleStrategyRefresh("anomaly")}
              type="button"
            >
              Refresh
            </button>
          </div>
        </header>

        {screenId === "scenario-anomaly" ? (
          <AnomalyScenarioBuilder
            plans={activeOptimizationPlans}
          />
        ) : null}
        {screenId === "scenario-guideline" ? (
          <GuidelineOverview
            guideMode={reportGuideMode}
            importNotice={importNotice}
            autoBlockMode={reportAutoBlockMode}
            onExport={() => exportScenarioPayload("guideline-policy", buildGuidelineExportPayload())}
            onAutoBlockModeChange={updateSharedAutoBlockMode}
            onGuideModeChange={updateSharedGuideMode}
            onImport={handleImport}
          />
        ) : null}
        {screenId === "report-summary" ? (
          <SummaryReport
            autoBlockMode={reportAutoBlockMode}
            guideMode={reportGuideMode}
            guideModeComparisons={guideModeComparisons}
            marketData={marketData}
            onAutoBlockModeChange={updateSharedAutoBlockMode}
            onGuideModeChange={updateSharedGuideMode}
            plans={activeOptimizationPlans}
            ranked={ranked}
          />
        ) : null}
        {screenId === "report-anomaly" ? (
          <AnomalyReport
            autoBlockMode={reportAutoBlockMode}
            comparisons={activeComparisons}
            guideMode={reportGuideMode}
            onAutoBlockModeChange={updateSharedAutoBlockMode}
            onGuideModeChange={updateSharedGuideMode}
            plans={activeOptimizationPlans}
          />
        ) : null}
        {isDailyScreen ? (
          <DailyOperationView
            autoBlockMode={activeDailyAutoBlockMode}
            chartInterval={chartInterval}
            guideMode={activeDailyGuideMode}
            marketData={operationMarketData}
            onAutoBlockModeChange={updateDailyAutoBlockMode}
            onChartIntervalChange={setChartInterval}
            onGuideModeChange={updateDailyGuideMode}
            onOpenMarket={openMarketPopup}
            onOpenOperation={(tab) =>
              openOperationPopup(
                activeDailyScreen,
                activeOptimizationPlans.find((plan) => plan.strategyId === activeDailyScreen.traderId),
                activeDailyGuideMode,
                activeDailyAutoBlockMode,
                tab,
              )
            }
            plan={activeOptimizationPlans.find((plan) => plan.strategyId === activeDailyScreen.traderId)}
            paperResult={activeDailyPaperResults[activeDailyScreen.traderId]}
            screen={activeDailyScreen}
            themeMode={themeMode}
            wsLiveResults={wsLiveResults}
            wsTraderId={activeDailyScreen.traderId}
          />
        ) : null}
      </section>

      {popup?.kind === "market" ? (
        <MarketInfoPopup
          blockedSignals={popup.blockedSignals}
          candles={selectedMarketCandles}
          currentReturn={popup.currentReturn}
          dayStartMs={popup.dayStartMs}
          interval={modalInterval}
          market={popup.market}
          onClose={() => setPopup(null)}
          onIntervalChange={setModalInterval}
          themeMode={themeMode}
          tradeSummary={popup.tradeSummary}
          trades={popup.trades}
        />
      ) : null}
      {popup?.kind === "operation" ? (
        <OperationInfoPopup
          candlesByMarket={operationMarketData.candlesByMarket}
          dailyPaperResults={dailyPaperResults}
          onClose={() => setPopup(null)}
          onTabChange={(tab) => setPopup((current) => (current?.kind === "operation" ? { ...current, tab } : current))}
          popup={popup}
        />
      ) : null}
      {refreshStatus?.running ? <RefreshOverlay status={refreshStatus} /> : null}
    </main>
  );
}

async function loadDashboardState(): Promise<
  [DashboardMarketData, DashboardResults | null, DashboardMarketData | null, DailyPaperResultsPayload | null]
> {
  const [dashboardMarketData, results, dailyOperationMarketData, dailyPaperResults] = await Promise.all([
    loadDashboardMarketData(),
    loadDashboardResults(),
    loadDailyOperationMarketData(),
    loadDailyPaperResults(),
  ]);
  return [dashboardMarketData, results, dailyOperationMarketData, dailyPaperResults];
}

async function loadDailyOperationState(): Promise<[DashboardMarketData | null, DailyPaperResultsPayload | null]> {
  return Promise.all([loadDailyOperationMarketData(), loadDailyPaperResults()]);
}

function getDailyPaperCaseResults(
  payload: DailyPaperResultsPayload | null,
  guideMode: GuideRuleMode,
  autoBlockMode: AutoBlockMode,
) {
  return payload?.caseResults?.[guideMode]?.[autoBlockMode] ?? payload?.results?.[guideMode] ?? {};
}

async function loadRefreshStatus(): Promise<StrategyRefreshStatus | null> {
  try {
    const response = await fetch("/api/strategy-refresh/status", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as StrategyRefreshStatus;
  } catch {
    return null;
  }
}



const ANOMALY_STRATEGY_INFO: Array<{
  id: TraderId;
  label: string;
  subtitle: string;
  entry: string;
  hold: string;
  trail: string;
  exit: string;
}> = [
  {
    id: "momentum",
    label: "Anomaly-A",
    subtitle: "Calm Impulse",
    entry: "15봉 이상 조용한 구간 (평균 바디 < 0.5%) 이후 첫 충동 캔들 진입. 바디 ≥ 1.5%, 거래량 ≥ 1.5× 48봉 평균, 48봉 ROC < 5%.",
    hold: "최대 12봉 (12분)",
    trail: "2.8% (적응형)",
    exit: "거래량 fade (< 1.2× 평균) 또는 시간 초과",
  },
  {
    id: "range-grid",
    label: "Anomaly-B",
    subtitle: "First Explosion",
    entry: "폭발 캔들 자체에 직접 진입. 바디 ≥ 2.5%, 거래량 ≥ 3.5×, 상단 비율 ≥ 60%, 선행 3봉 조용함 필수.",
    hold: "최대 6봉 (6분)",
    trail: "1.8% (적응형)",
    exit: "거래량 fade (< 1.3×) 또는 역봉 (바디 < −0.8%) 또는 시간 초과",
  },
  {
    id: "arbitrage",
    label: "Anomaly-C",
    subtitle: "Confirmed Burst",
    entry: "폭발 다음 봉에서 확인 후 진입. 이전 봉: 바디 ≥ 2.5% + 거래량 ≥ 3.5×. 현재 봉: 거래량 ≥ 1.8× + 상승 유지.",
    hold: "최대 8봉 (8분)",
    trail: "2.2% (적응형)",
    exit: "거래량 fade (< 1.2×) 또는 역봉 (바디 < −1%) 또는 시간 초과",
  },
  {
    id: "anomaly",
    label: "Anomaly-D",
    subtitle: "Sweep Best",
    entry: "상대 거래량 ≥ 3.5×, 3봉 가격 가속 ≥ 4.5%, 24봉 고점 돌파, 과열 (48봉 ROC < 18%) 미초과.",
    hold: "최대 12봉 (12분)",
    trail: "1.8% (적응형)",
    exit: "거래량 fade (< 1.2× 평균) 또는 시간 초과",
  },
];

function AnomalyScenarioBuilder({
  plans,
}: {
  plans: TraderOptimizationPlan[];
}) {
  const [selectedId, setSelectedId] = useState<TraderId>("momentum");
  const selected = ANOMALY_STRATEGY_INFO.find((s) => s.id === selectedId)!;
  const plan = plans.find((p) => p.strategyId === selectedId);

  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h3>특이점 전략 A/B/C/D 개요</h3>
            <p>4개 전략은 동일한 종목 리스트(특이점 감지 종목)를 공통으로 감시하며, 진입 타이밍과 보유 방식만 다릅니다.</p>
          </div>
          <strong>{plan?.selectedMarkets.length ?? 0}개 감시</strong>
        </div>
        <div className="logic-grid" style={{ marginBottom: "12px" }}>
          <InfoTile title="종목 선택" value="hist5m 90일 스캔 (10%/3×) + live 1m 24h → union. 마지막 특이점 후 45일 초과 시 제거." />
          <InfoTile title="파라미터 적응" value="전일 live 1m 특이점 이벤트의 중앙값 가격이동 기준으로 trailingStop / maxHold 자동 조정." />
          <InfoTile title="쿨다운" value="동일 이벤트 중복 감지 방지. 5m: 24봉(2h), 1m: 120봉(2h)." />
          <InfoTile title="공통 조건" value="Guideline X (ignored) 모드 기준. 특이점 종목에서 각 전략이 독립 신호를 냅니다." />
        </div>
        <div className="choice-tabs">
          {ANOMALY_STRATEGY_INFO.map((s) => (
            <button
              className={selectedId === s.id ? "active" : ""}
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="scenario-grid scenario-grid--single">
          <article className="scenario-card">
            <h4>{selected.label} / {selected.subtitle}</h4>
            <div className="logic-grid">
              <InfoTile title="진입 조건" value={selected.entry} />
              <InfoTile title="보유 한도" value={selected.hold} />
              <InfoTile title="Trailing Stop" value={selected.trail} />
              <InfoTile title="청산 조건" value={selected.exit} />
            </div>
            <small>{plan ? `${plan.selectedMarkets.length}개 감시 종목 준비됨` : "데이터 없음 — npm run sim:anomaly 실행 필요"}</small>
          </article>
        </div>
      </section>
    </>
  );
}

function GuidelineOverview({
  autoBlockMode,
  guideMode,
  importNotice,
  onAutoBlockModeChange,
  onExport,
  onGuideModeChange,
  onImport,
}: {
  autoBlockMode: AutoBlockMode;
  guideMode: GuideRuleMode;
  importNotice: string;
  onAutoBlockModeChange: (mode: AutoBlockMode) => void;
  onExport: () => void;
  onGuideModeChange: (mode: GuideRuleMode) => void;
  onImport: (file: File | undefined, scope: string) => void;
}) {
  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h3>기본 Guideline/Safety 개요</h3>
            <p>모든 전략은 Guideline O/X와 Safety O/X를 같은 기준으로 비교합니다. 여기에서 바꾸면 Report와 Daily Operation에도 같이 반영됩니다.</p>
          </div>
          <GuideRuleToggle mode={guideMode} onChange={onGuideModeChange} />
        </div>
        <div className="logic-grid">
          <InfoTile title="Trend" value="다우 구조, 고점/저점 갱신, 추세 이탈 여부를 확인합니다." />
          <InfoTile title="MA" value="단기/중기 이동평균의 방향과 골든크로스/데드크로스를 필터로 사용합니다." />
          <InfoTile title="Support" value="지지/저항 반응과 돌파 후 재확인을 매수/매도 근거로 기록합니다." />
          <InfoTile title="Safety" value="최대 손실, 과열 진입, 데이터 지연, 중복 주문, 비상 정지를 자동 차단 기준으로 둡니다." />
        </div>
        <ScenarioIOControls exportLabel="Guideline export" importScope="Guideline" onExport={onExport} onImport={onImport} />
      </section>
      <RiskAnswerPanel autoBlockMode={autoBlockMode} onAutoBlockModeChange={onAutoBlockModeChange} />
      <NoticePanel title="Import 상태" value={importNotice} />
    </>
  );
}

function SummaryReport({
  autoBlockMode,
  guideMode,
  guideModeComparisons,
  marketData,
  onAutoBlockModeChange,
  onGuideModeChange,
  plans,
  ranked,
}: {
  autoBlockMode: AutoBlockMode;
  guideMode: GuideRuleMode;
  guideModeComparisons: StrategyGuideModeComparison[];
  marketData: DashboardMarketData;
  onAutoBlockModeChange: (mode: AutoBlockMode) => void;
  onGuideModeChange: (mode: GuideRuleMode) => void;
  plans: TraderOptimizationPlan[];
  ranked: StrategyComparison[];
}) {
  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h3>Summary</h3>
            <p>
              {marketData.isRealUpbitData
                ? `Upbit public ${marketData.source} candles. Generated: ${formatGeneratedAt(marketData.generatedAt)}`
                : "Sample data is active. Upbit public cache가 없으면 샘플 데이터로 표시합니다."}
            </p>
          </div>
          <div className="operation-toggles">
            <GuideRuleToggle mode={guideMode} onChange={onGuideModeChange} />
            <AutoBlockToggle mode={autoBlockMode} onChange={onAutoBlockModeChange} />
          </div>
        </div>
        <ComparisonTable ranked={ranked} />
      </section>
      <CaseComparisonView caseRows={buildCaseComparisonRows(guideModeComparisons, marketData.candlesByMarket)} />
      <OptimizationSummary optimizationPlans={plans} />
    </>
  );
}


function AnomalyReport({
  autoBlockMode,
  comparisons,
  guideMode,
  onAutoBlockModeChange,
  onGuideModeChange,
  plans,
}: {
  autoBlockMode: AutoBlockMode;
  comparisons: StrategyComparison[];
  guideMode: GuideRuleMode;
  onAutoBlockModeChange: (mode: AutoBlockMode) => void;
  onGuideModeChange: (mode: GuideRuleMode) => void;
  plans: TraderOptimizationPlan[];
}) {
  const anomalyIds: TraderId[] = ["momentum", "range-grid", "arbitrage", "anomaly"];
  const [selectedId, setSelectedId] = useState<TraderId>("momentum");
  const info = ANOMALY_STRATEGY_INFO.find((s) => s.id === selectedId)!;
  const comparison = comparisons.find((c) => c.bestResult.strategyId === selectedId);
  const plan = plans.find((p) => p.strategyId === selectedId);

  return (
    <>
      <section className="panel">
        <div className="section-head">
          <div>
            <h3>특이점 전략 리포트</h3>
            <p>A/B/C/D 전략의 백테스트 결과. 동일 종목 리스트, 다른 진입 타이밍.</p>
          </div>
          <div className="operation-toggles">
            <GuideRuleToggle mode={guideMode} onChange={onGuideModeChange} />
            <AutoBlockToggle mode={autoBlockMode} onChange={onAutoBlockModeChange} />
          </div>
        </div>
        <div className="choice-tabs">
          {anomalyIds.map((id) => {
            const s = ANOMALY_STRATEGY_INFO.find((x) => x.id === id)!;
            return (
              <button
                className={selectedId === id ? "active" : ""}
                key={id}
                onClick={() => setSelectedId(id)}
                type="button"
              >
                {s.label}
              </button>
            );
          })}
        </div>
        <div style={{ marginBottom: "8px" }}>
          <strong style={{ fontSize: "0.9rem", color: "var(--muted)" }}>{info.label} / {info.subtitle}</strong>
        </div>
        {comparison ? (
          <MetricStrip result={comparison.bestResult} />
        ) : (
          <div className="empty-state">결과 없음 — 백테스트 데이터가 아직 없습니다.</div>
        )}
      </section>
      {plan ? (
        <section className="panel">
          <div className="section-head">
            <div>
              <h3>{info.label} 종목별 결과</h3>
              <p>{info.subtitle} — 감시 종목 {plan.selectedMarkets.length}개</p>
            </div>
            <strong>{shortMarket(comparison?.bestResult.market ?? "TBD")}</strong>
          </div>
          <OptimizationPlanView plan={plan} />
        </section>
      ) : null}
    </>
  );
}

function DailyOperationView({
  autoBlockMode,
  chartInterval,
  guideMode,
  marketData,
  onAutoBlockModeChange,
  onChartIntervalChange,
  onGuideModeChange,
  onOpenMarket,
  onOpenOperation,
  plan,
  paperResult,
  screen,
  themeMode,
  wsLiveResults,
  wsTraderId,
}: {
  autoBlockMode: AutoBlockMode;
  chartInterval: ChartInterval;
  guideMode: GuideRuleMode;
  marketData: DashboardMarketData;
  onAutoBlockModeChange: (mode: AutoBlockMode) => void;
  onChartIntervalChange: (interval: ChartInterval) => void;
  onGuideModeChange: (mode: GuideRuleMode) => void;
  onOpenMarket: (market: string, trades: Trade[], blockedSignals: BlockedSignal[], currentReturn: number, tradeSummary: TradeSummary, dayStartMs: number | undefined) => void;
  onOpenOperation: (tab: OperationPopupTab) => void;
  plan: TraderOptimizationPlan | undefined;
  paperResult: DailyPaperResult | undefined;
  screen: { title: string; traderId: TraderId; description: string };
  themeMode: ThemeMode;
  wsLiveResults: WsLiveResults | null;
  wsTraderId: TraderId;
}) {
  const profile = traderProfiles.find((item) => item.id === screen.traderId);
  const entries = useMemo(
    () => buildDailyEntries(plan, marketData.candlesByMarket, autoBlockMode, paperResult),
    [autoBlockMode, marketData.candlesByMarket, paperResult, plan],
  );
  const signals = useMemo(() => buildDailySignals(entries), [entries]);
  const operationSummary = useMemo(
    () => buildDailyOperationSummary(entries, paperResult, plan, marketData.candlesByMarket, autoBlockMode),
    [autoBlockMode, entries, marketData.candlesByMarket, paperResult, plan],
  );
  const decision = useMemo(
    () =>
      decideDailyOperation({
        currentPosition: null,
        now: Date.now(),
        signals,
      }),
    [signals],
  );

  const [wsViewMode, setWsViewMode] = useState<"ws-o" | "ws-x">("ws-x");
  const wsO = wsLiveResults?.wsO?.[wsTraderId];
  const wsX = wsLiveResults?.wsX?.[wsTraderId];
  const wsConnected = wsLiveResults?.status === "connected";
  const wsDotColor = wsConnected ? "#4ade80" : wsLiveResults ? "#f87171" : "#94a3b8";
  const wsStatusLabel = wsLiveResults ? (wsConnected ? `WS ${wsLiveResults.tickCount.toLocaleString()}t` : "WS offline") : "WS -";
  function formatWsResult(result?: { returnRate: number; trades: number } | null) {
    if (!result) return "-";
    return `${formatPct(result.returnRate)} (${result.trades}t)`;
  }
  return (
    <>
      <section className="panel daily-control-panel">
        <div className="section-head">
          <div>
            <h3>{screen.title}</h3>
            <p>{screen.description}</p>
          </div>
          <div className="operation-toggles">
            <GuideRuleToggle mode={guideMode} onChange={onGuideModeChange} />
            <AutoBlockToggle mode={autoBlockMode} onChange={onAutoBlockModeChange} />
            <div className="toggle-group ws-toggle-group">
              <span className="ws-status-dot" style={{ color: wsDotColor }} title={wsStatusLabel}>{wsStatusLabel}</span>
              <button className={wsViewMode === "ws-o" ? "active" : ""} onClick={() => setWsViewMode("ws-o")} type="button">WS O</button>
              <button className={wsViewMode === "ws-x" ? "active" : ""} onClick={() => setWsViewMode("ws-x")} type="button">WS X</button>
            </div>
          </div>
        </div>
        <div className="daily-summary">
          <InfoTile title="Best 코인" value={operationSummary.bestMarket} />
          <InfoTile title="Best 거래 요약" value={operationSummary.bestTradeSummary} />
          <InfoTile title="Best 코인 수익률" value={formatPct(operationSummary.bestReturn)} />
          <InfoTile title="전체 수익률" value={formatPct(operationSummary.totalReturn)} />
          <InfoTile title="WS-O 수익률" value={formatWsResult(wsO)} />
          <InfoTile title="WS-X 수익률" value={formatWsResult(wsX)} />
        </div>
      </section>

      <section className="panel watch-panel">
        <div className="section-head">
          <div className="inline-title">
            <h3>Daily Operation 화면</h3>
            <IntervalControls interval={chartInterval} onChange={onChartIntervalChange} label="Chart period" compact />
          </div>
          <div className="operation-panel-actions">
            <button onClick={() => onOpenOperation("trades")} type="button">Trades</button>
            <button onClick={() => onOpenOperation("returns")} type="button">Return</button>
            <button onClick={() => onOpenOperation("balance")} type="button">Balance</button>
          </div>
        </div>
        <div className="watch-grid" aria-label="Daily operation markets">
          {entries.map(({ blockedSignals, candles, currentReturn, dayStartMs, label, market, tradeSummary, trades }) => {
            const aggregated = aggregateCandles(candles, chartInterval);

            return (
              <article
                className="symbol-card"
                key={market}
                onClick={() => onOpenMarket(market, trades, blockedSignals, currentReturn, tradeSummary, dayStartMs)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onOpenMarket(market, trades, blockedSignals, currentReturn, tradeSummary, dayStartMs);
                }}
                role="button"
                tabIndex={0}
              >
                <div className="symbol-card-head">
                  <strong>{shortMarket(market)}</strong>
                  <span className={currentReturn >= 0 ? "gain" : "loss"} title="오늘 기준점 대비 현재가 수익률">
                    {formatPct(currentReturn)}
                  </span>
                </div>
                <div className="symbol-meta">
                  <span>{label}</span>
                  <strong style={{ color: tradeSummary.returnRate > 0 ? "#7dd3fc" : tradeSummary.returnRate < 0 ? "#ef8181" : "#ffffff" }}>{formatTradeSummary(tradeSummary)}</strong>
                </div>
                <MarketChart blockedSignals={blockedSignals} candles={aggregated} boundaryTimestamp={dayStartMs} interval={chartInterval} themeMode={themeMode} trades={trades} variant="mini" />
              </article>
            );
          })}
          {entries.length === 0 ? <div className="empty-state">선택된 감시 종목이 아직 없습니다.</div> : null}
        </div>
      </section>

    </>
  );
}

function MarketInfoPopup({
  blockedSignals,
  candles,
  currentReturn,
  dayStartMs,
  interval,
  market,
  onClose,
  onIntervalChange,
  themeMode,
  tradeSummary,
  trades,
}: {
  blockedSignals: BlockedSignal[];
  candles: Candle[];
  currentReturn: number;
  dayStartMs: number | undefined;
  interval: ChartInterval;
  market: string;
  onClose: () => void;
  onIntervalChange: (interval: ChartInterval) => void;
  themeMode: ThemeMode;
  tradeSummary: TradeSummary;
  trades: Trade[];
}) {
  const aggregated = useMemo(() => aggregateCandles(candles, interval), [candles, interval]);

  return (
    <div className="chart-modal-backdrop" onClick={onClose} role="presentation">
      <section className="chart-modal" onClick={(event) => event.stopPropagation()}>
        <div className="chart-modal-head">
          <div>
            <p className="eyebrow">Market Popup</p>
            <h3>{shortMarket(market)}</h3>
          </div>
          <div className="chart-modal-actions">
            <IntervalControls interval={interval} onChange={onIntervalChange} label="Large chart" />
            <button className="icon-button" onClick={onClose} type="button" aria-label="Close popup">
              X
            </button>
          </div>
        </div>
        <MarketChart
          blockedSignals={blockedSignals}
          candles={aggregated}
          boundaryTimestamp={dayStartMs}
          interval={interval}
          metrics={{
            detail: formatTradeSummary(tradeSummary),
            detailClassName: tradeSummary.returnRate >= 0 ? "gain" : "loss",
            returnRate: currentReturn,
            returnTitle: "오늘 기준점 대비 현재가 수익률",
          }}
          themeMode={themeMode}
          trades={trades}
          variant="large"
        />
      </section>
    </div>
  );
}

function OperationInfoPopup({
  candlesByMarket,
  dailyPaperResults,
  onClose,
  onTabChange,
  popup,
}: {
  candlesByMarket: Record<string, Candle[]>;
  dailyPaperResults: DailyPaperResultsPayload | null;
  onClose: () => void;
  onTabChange: (tab: OperationPopupTab) => void;
  popup: Extract<PopupState, { kind: "operation" }>;
}) {
  const [guideFilter, setGuideFilter] = useState<GuideFilterMode>(popup.tab === "balance" ? "all" : popup.guideMode);
  const [safetyFilter, setSafetyFilter] = useState<SafetyFilterMode>(popup.tab === "balance" ? "all" : popup.autoBlockMode);
  useEffect(() => {
    if (popup.tab !== "balance") return;
    setGuideFilter("all");
    setSafetyFilter("all");
  }, [popup.tab]);

  const cases = useMemo(
    () => buildOperationCases(dailyPaperResults, popup.traderId, popup.plan, candlesByMarket),
    [candlesByMarket, dailyPaperResults, popup.plan, popup.traderId],
  );
  const filteredCases = useMemo(
    () =>
      cases.filter(
        (item) =>
          (guideFilter === "all" || item.guideMode === guideFilter) &&
          (safetyFilter === "all" || item.autoBlockMode === safetyFilter),
      ),
    [cases, guideFilter, safetyFilter],
  );
  const operationTrades = useMemo(
    () =>
      filteredCases
        .flatMap((item) => item.trades.map((trade) => ({ ...trade, caseLabel: item.label })))
        .sort((a, b) => a.timestamp - b.timestamp),
    [filteredCases],
  );
  const returnTrendSeries = useMemo(
    () => buildOperationReturnSeries(filteredCases, popup.plan),
    [filteredCases, popup.plan],
  );
  const balanceTrendSeries = useMemo(() => buildOperationBalanceSeries(filteredCases), [filteredCases]);

  return (
    <div className="chart-modal-backdrop" onClick={onClose} role="presentation">
      <section className="chart-modal" onClick={(event) => event.stopPropagation()}>
        <div className="chart-modal-head">
          <div>
            <p className="eyebrow">Daily Operation Popup</p>
            <h3>{popup.title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close popup">
            X
          </button>
        </div>
        <div className="popup-tabs">
          <TabButton active={popup.tab === "trades"} label="Trades" onClick={() => onTabChange("trades")} />
          <TabButton active={popup.tab === "returns"} label="Return Trend" onClick={() => onTabChange("returns")} />
          <TabButton active={popup.tab === "balance"} label="Balance Trend" onClick={() => onTabChange("balance")} />
        </div>
        <OperationPopupFilters
          guideFilter={guideFilter}
          safetyFilter={safetyFilter}
          onGuideFilterChange={setGuideFilter}
          onSafetyFilterChange={setSafetyFilter}
        />
        {popup.tab === "trades" ? <TradeTable trades={operationTrades} /> : null}
        {popup.tab === "returns" ? <TrendGraph series={returnTrendSeries} type="returns" /> : null}
        {popup.tab === "balance" ? <TrendGraph series={balanceTrendSeries} type="balance" /> : null}
      </section>
    </div>
  );
}

function OperationPopupFilters({
  guideFilter,
  onGuideFilterChange,
  onSafetyFilterChange,
  safetyFilter,
}: {
  guideFilter: GuideFilterMode;
  onGuideFilterChange: (mode: GuideFilterMode) => void;
  onSafetyFilterChange: (mode: SafetyFilterMode) => void;
  safetyFilter: SafetyFilterMode;
}) {
  return (
    <div className="popup-filters">
      <div className="segmented" aria-label="Guideline filter">
        <button className={guideFilter === "all" ? "active" : ""} onClick={() => onGuideFilterChange("all")} type="button">
          Guideline All
        </button>
        <button className={guideFilter === "strict" ? "active" : ""} onClick={() => onGuideFilterChange("strict")} type="button">
          Guideline O
        </button>
        <button className={guideFilter === "ignored" ? "active" : ""} onClick={() => onGuideFilterChange("ignored")} type="button">
          Guideline X
        </button>
      </div>
      <div className="segmented" aria-label="Safety filter">
        <button className={safetyFilter === "all" ? "active" : ""} onClick={() => onSafetyFilterChange("all")} type="button">
          Safety All
        </button>
        <button className={safetyFilter === "enabled" ? "active" : ""} onClick={() => onSafetyFilterChange("enabled")} type="button">
          Safety O
        </button>
        <button className={safetyFilter === "disabled" ? "active" : ""} onClick={() => onSafetyFilterChange("disabled")} type="button">
          Safety X
        </button>
      </div>
    </div>
  );
}

function ScenarioIOControls({
  exportLabel,
  importScope,
  onExport,
  onImport,
}: {
  exportLabel: string;
  importScope: string;
  onExport: () => void;
  onImport: (file: File | undefined, scope: string) => void;
}) {
  return (
    <div className="io-controls">
      <button className="utility-button" onClick={onExport} type="button">
        Export
      </button>
      <label className="file-button">
        Import
        <input accept="application/json,.json" aria-label={exportLabel} onChange={(event) => onImport(event.target.files?.[0], importScope)} type="file" />
      </label>
    </div>
  );
}

function GuideRuleToggle({ mode, onChange }: { mode: GuideRuleMode; onChange: (mode: GuideRuleMode) => void }) {
  return (
    <div className="segmented" aria-label="Guideline mode">
      <button className={mode === "strict" ? "active" : ""} onClick={() => onChange("strict")} type="button">
        Guideline O
      </button>
      <button className={mode === "ignored" ? "active" : ""} onClick={() => onChange("ignored")} type="button">
        Guideline X
      </button>
    </div>
  );
}

function AutoBlockToggle({ mode, onChange }: { mode: AutoBlockMode; onChange: (mode: AutoBlockMode) => void }) {
  return (
    <div className="segmented" aria-label="Safety mode">
      <button className={mode === "enabled" ? "active" : ""} onClick={() => onChange("enabled")} type="button">
        Safety O
      </button>
      <button className={mode === "disabled" ? "active" : ""} onClick={() => onChange("disabled")} type="button">
        Safety X
      </button>
    </div>
  );
}

function ComparisonTable({ ranked }: { ranked: StrategyComparison[] }) {
  return (
    <div className="table">
      <div className="row header">
        <span>Rank</span>
        <span>Strategy</span>
        <span>Scenario</span>
        <span>Best Market</span>
        <span>Return</span>
        <span>Max DD</span>
        <span>Trades</span>
      </div>
      {ranked.map((comparison, index) => (
        <div
          className="row"
          key={`${comparison.bestResult.strategyId}-${comparison.bestResult.market}-${comparison.bestResult.scenarioId}-${index}`}
        >
          <span>{index + 1}</span>
          <span>{comparison.strategyName}</span>
          <span>{comparison.bestResult.scenarioName ?? comparison.bestResult.scenarioId}</span>
          <span>{shortMarket(comparison.bestResult.market)}</span>
          <span className={comparison.bestResult.returnRate >= 0 ? "gain" : "loss"}>
            {formatPct(comparison.bestResult.returnRate)}
          </span>
          <span>{formatPct(comparison.bestResult.maxDrawdown)}</span>
          <span>{comparison.bestResult.tradeCount}</span>
        </div>
      ))}
    </div>
  );
}

function OptimizationSummary({ optimizationPlans }: { optimizationPlans: TraderOptimizationPlan[] }) {
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>Monitoring Selection Summary</h3>
          <p>각 전략은 후보 30개를 평가한 뒤 Anomaly 조건에 맞는 감시 대상을 선택합니다.</p>
        </div>
        <strong>Top 30 -&gt; 12</strong>
      </div>
      <div className="optimization-grid">
        {optimizationPlans.map((plan) => (
          <article className="optimization-card" key={plan.strategyId}>
            <div>
              <strong>{plan.strategyName}</strong>
              <span>{plan.guideRuleMode}</span>
            </div>
            <p>
              Candidates {plan.candidateMarkets.length}/{plan.candidateMarketCount} - Selected{" "}
              {plan.selectedMarkets.length}/{plan.monitoringMarketCount}
            </p>
            <small>{plan.selectedMarkets.map((item) => shortMarket(item.market)).join(", ") || "No selected markets"}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function CaseComparisonView({ caseRows }: { caseRows: CaseComparisonRow[] }) {
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>Guideline / Safety Case Comparison</h3>
          <p>각 전략을 4가지 Case로 비교합니다. Safety O는 동일한 backtest 거래에서 자동 차단 규칙을 적용한 추정 결과입니다.</p>
        </div>
        <strong>4 Cases</strong>
      </div>
      <div className="case-table">
        <div className="case-row header">
          <span>Strategy</span>
          <span>Best Case</span>
          <span>Guideline O / Safety O</span>
          <span>Guideline O / Safety X</span>
          <span>Guideline X / Safety O</span>
          <span>Guideline X / Safety X</span>
        </div>
        {caseRows.map((row) => (
          <div className="case-row" key={row.strategyName}>
            <span>{row.strategyName}</span>
            <span>{row.bestCase.label}</span>
            {row.cases.map((item) => (
              <CaseMetricCell item={item} key={item.label} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function CaseMetricCell({ item }: { item: CaseMetric }) {
  return (
    <span className="case-metric">
      <strong className={item.returnRate >= 0 ? "gain" : "loss"}>{formatPct(item.returnRate)}</strong>
      <small>DD {formatPct(item.maxDrawdown)}</small>
      <small>
        T {item.trades} / B {item.blocked}
      </small>
    </span>
  );
}

function GuideModeComparisonView({ guideModeComparisons }: { guideModeComparisons: StrategyGuideModeComparison[] }) {
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>Guide Rule Split</h3>
          <p>Guideline O와 X를 나누어 필터가 수익률과 거래 수에 미치는 영향을 봅니다.</p>
        </div>
        <strong>Strict / Ignored</strong>
      </div>
      <div className="guide-table">
        <div className="guide-row header">
          <span>Strategy</span>
          <span>Best mode</span>
          <span>Strict return</span>
          <span>Rejected</span>
          <span>Ignored return</span>
          <span>Delta</span>
          <span>Trades</span>
        </div>
        {guideModeComparisons.map((comparison) => {
          const strict = comparison.strict.bestResult;
          const ignored = comparison.ignored.bestResult;
          const delta = strict.returnRate - ignored.returnRate;

          return (
            <div className="guide-row" key={comparison.strategyName}>
              <span>{comparison.strategyName}</span>
              <span>{comparison.bestMode}</span>
              <span className={strict.returnRate >= 0 ? "gain" : "loss"}>{formatPct(strict.returnRate)}</span>
              <span>{strict.guideRejectedSignals}</span>
              <span className={ignored.returnRate >= 0 ? "gain" : "loss"}>{formatPct(ignored.returnRate)}</span>
              <span className={delta >= 0 ? "gain" : "loss"}>{formatPct(delta)}</span>
              <span>
                {strict.tradeCount} / {ignored.tradeCount}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type OptSortKey = "pick" | "market" | "candidate" | "scenario" | "return" | "maxdd" | "rejected";

function OptimizationPlanView({ limit, plan }: { limit?: number; plan: TraderOptimizationPlan }) {
  const [sortKey, setSortKey] = useState<OptSortKey>("return");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const base = limit ? plan.selectedMarkets.slice(0, limit) : plan.selectedMarkets;

  const sorted = base.slice().sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "pick":      cmp = (a.candidateRank ?? 0) - (b.candidateRank ?? 0); break;
      case "market":    cmp = shortMarket(a.market).localeCompare(shortMarket(b.market)); break;
      case "candidate": cmp = (a.candidateRank ?? 0) - (b.candidateRank ?? 0); break;
      case "scenario":  cmp = (a.bestResult.scenarioName ?? "").localeCompare(b.bestResult.scenarioName ?? ""); break;
      case "return":    cmp = a.bestResult.returnRate - b.bestResult.returnRate; break;
      case "maxdd":     cmp = a.bestResult.maxDrawdown - b.bestResult.maxDrawdown; break;
      case "rejected":  cmp = (a.bestResult.guideRejectedSignals ?? 0) - (b.bestResult.guideRejectedSignals ?? 0); break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  function handleSort(key: OptSortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "return" ? "desc" : "asc");
    }
  }

  function SortHeader({ label, col }: { label: string; col: OptSortKey }) {
    const active = sortKey === col;
    const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => handleSort(col)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleSort(col); }}
        style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", color: active ? "var(--accent)" : undefined }}
      >
        {label}{arrow}
      </span>
    );
  }

  return (
    <div className="optimization-table">
      <div className="optimization-row header">
        <SortHeader label="Pick"      col="pick" />
        <SortHeader label="Market"    col="market" />
        <SortHeader label="Candidate" col="candidate" />
        <SortHeader label="Scenario"  col="scenario" />
        <SortHeader label="Return"    col="return" />
        <SortHeader label="Max DD"    col="maxdd" />
        <SortHeader label="Rejected"  col="rejected" />
      </div>
      {sorted.map((item, index) => (
        <div className="optimization-row" key={item.market}>
          <span>{index + 1}</span>
          <span>{shortMarket(item.market)}</span>
          <span>#{item.candidateRank}</span>
          <span>{item.bestResult.scenarioName ?? item.bestResult.scenarioId}</span>
          <span className={item.bestResult.returnRate >= 0 ? "gain" : "loss"}>{formatPct(item.bestResult.returnRate)}</span>
          <span>{formatPct(item.bestResult.maxDrawdown)}</span>
          <span>{item.bestResult.guideRejectedSignals}</span>
        </div>
      ))}
    </div>
  );
}

function MetricStrip({ result }: { result: BacktestResult }) {
  return (
    <div className="metric-grid">
      <Metric label="Best market" value={shortMarket(result.market)} />
      <Metric label="Scenario" value={result.scenarioName ?? result.scenarioId} />
      <Metric label="Final value" value={formatKrw(result.finalValue)} />
      <Metric label="Return" value={formatPct(result.returnRate)} />
      <Metric label="Max DD" value={formatPct(result.maxDrawdown)} />
      <Metric label="Win rate" value={formatPct(result.winRate)} />
      <Metric label="Trades" value={String(result.tradeCount)} />
      <Metric label="Profit factor" value={formatProfitFactor(result.profitFactor)} />
    </div>
  );
}

function TradeTable({ trades }: { trades: DisplayTrade[] }) {
  const rows = trades.slice().sort((a, b) => a.timestamp - b.timestamp);

  return (
    <div className="trade-list">
      <div className="trade-row header">
        <span>Time</span>
        <span>Market</span>
        <span>Case</span>
        <span>Side</span>
        <span>Price</span>
        <span>Quantity</span>
        <span>Reason</span>
      </div>
      {rows.length > 0 ? (
        rows.map((trade) => (
          <div className="trade-row" key={`${trade.timestamp}-${trade.side}-${trade.price}`}>
            <span>{formatTradeTime(trade.timestamp)}</span>
            <span>{shortMarket(trade.market)}</span>
            <span>{trade.caseLabel ?? "-"}</span>
            <span className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</span>
            <span>{formatKrw(trade.price)}</span>
            <span>{trade.quantity.toFixed(6)}</span>
            <span>{trade.reasonCodes.join(", ")}</span>
          </div>
        ))
      ) : (
        <div className="empty-state">거래내역이 아직 없습니다.</div>
      )}
    </div>
  );
}

interface TrendSeries {
  color: string;
  dashArray?: string;
  guideMode?: GuideRuleMode;
  label: string;
  market?: string;
  points: Array<{ timestamp: number; value: number }>;
  safetyMode?: AutoBlockMode;
}

function TrendGraph({ series, type }: { series: TrendSeries[]; type: "returns" | "balance" }) {
  const allPoints = series.flatMap((item) => item.points);
  if (allPoints.length === 0) {
    return <div className="empty-state">No trend data yet.</div>;
  }

  const minTime = Math.min(...allPoints.map((point) => point.timestamp));
  const maxTime = Math.max(...allPoints.map((point) => point.timestamp));
  const values = allPoints.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const width = 900;
  const height = 320;
  const padding = {
    bottom: 34,
    left: type === "balance" ? 94 : 66,
    right: 44,
    top: 34,
  };
  const yTicks = buildTrendTicks(minValue, maxValue, 5);

  return (
    <div className="trend-panel">
      {type === "returns" ? <ReturnTrendLegend series={series} /> : <DefaultTrendLegend series={series} />}
      <svg className="trend-graph" viewBox={`0 0 ${width} ${height}`} role="img">
        <line x1={padding.left} x2={width - padding.right} y1={height - padding.bottom} y2={height - padding.bottom} />
        <line x1={padding.left} x2={padding.left} y1={padding.top} y2={height - padding.bottom} />
        {yTicks.map((tick) => {
          const point = toTrendPoint({ timestamp: minTime, value: tick }, minTime, maxTime, minValue, maxValue, width, height, padding);
          const y = Number(point.split(",")[1]);
          return (
            <g className="trend-y-tick" key={tick}>
              <line x1={padding.left - 4} x2={width - padding.right} y1={y} y2={y} />
              <text x={padding.left - 8} y={y + 4}>
                {type === "returns" ? formatPct(tick) : formatCompactKrw(tick)}
              </text>
            </g>
          );
        })}
        {series.map((item) => (
          <polyline
            fill="none"
            key={item.label}
            points={item.points.map((point) => toTrendPoint(point, minTime, maxTime, minValue, maxValue, width, height, padding)).join(" ")}
            stroke={item.color}
            strokeDasharray={item.dashArray}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.4"
          />
        ))}
      </svg>
      <div className="trend-range">
        <span>{formatHour(minTime)}</span>
        <strong>
          {type === "returns" ? `${formatPct(minValue)} ~ ${formatPct(maxValue)}` : `${formatKrw(minValue)} ~ ${formatKrw(maxValue)}`}
        </strong>
        <span>{formatHour(maxTime)}</span>
      </div>
    </div>
  );
}

function DefaultTrendLegend({ series }: { series: TrendSeries[] }) {
  return (
    <div className="trend-legend">
      {series.map((item) => (
        <TrendLegendLine color={item.color} dashArray={item.dashArray} key={item.label} label={item.label} />
      ))}
    </div>
  );
}

function ReturnTrendLegend({ series }: { series: TrendSeries[] }) {
  const marketItems = Array.from(
    new Map(series.filter((item) => item.market).map((item) => [item.market as string, item.color])).entries(),
  ).sort(([a], [b]) => a.localeCompare(b));
  const caseItems: Array<{ autoBlockMode: AutoBlockMode; label: string; guideMode: GuideRuleMode }> = [
    { autoBlockMode: "enabled", guideMode: "strict", label: "Guideline O / Safety O" },
    { autoBlockMode: "disabled", guideMode: "strict", label: "Guideline O / Safety X" },
    { autoBlockMode: "enabled", guideMode: "ignored", label: "Guideline X / Safety O" },
    { autoBlockMode: "disabled", guideMode: "ignored", label: "Guideline X / Safety X" },
  ];

  return (
    <div className="trend-legend-groups">
      <div className="trend-legend-group">
        <strong>Coin</strong>
        <div className="trend-legend">
          {marketItems.map(([market, color]) => (
            <span key={market}>
              <i style={{ background: color }} />
              {shortMarket(market)}
            </span>
          ))}
        </div>
      </div>
      <div className="trend-legend-group">
        <strong>Guideline / Safety</strong>
        <div className="trend-legend">
          {caseItems.map((item) => (
            <TrendLegendLine
              color="var(--muted-strong)"
              dashArray={getOperationCaseDashArray(item)}
              key={item.label}
              label={item.label}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function TrendLegendLine({ color, dashArray, label }: { color: string; dashArray?: string; label: string }) {
  return (
    <span>
      <svg className="trend-legend-line" viewBox="0 0 34 8" aria-hidden="true">
        <line
          x1="1"
          x2="33"
          y1="4"
          y2="4"
          stroke={color}
          strokeDasharray={dashArray}
          strokeLinecap="round"
          strokeWidth="3"
        />
      </svg>
      {label}
    </span>
  );
}

function LogicReviewPanel() {
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>로직 확인 사항</h3>
          <p>수익률을 높이는 단일 조건 추가보다 검증 방식 개선이 먼저입니다.</p>
        </div>
        <strong>Review</strong>
      </div>
      <div className="logic-grid">
        <InfoTile title="특이점 정의" value="10분 가격변동 > 10% AND 10분 거래대금 > 직전 1시간 평균의 3배. 2시간 쿨다운으로 중복 카운트 방지." />
        <InfoTile title="전략 타이밍" value="A는 조용한 구간 후 첫 충동, B는 폭발 캔들 즉시, C는 폭발 다음 봉 확인 후, D는 가속+거래량 스파이크." />
        <InfoTile title="공통 리스크" value="슬리피지와 빠른 반전이 주요 리스크. trailingStop과 maxHold를 전일 이벤트 크기에 맞게 적응시킵니다." />
      </div>
    </section>
  );
}

function RiskAnswerPanel({
  autoBlockMode,
  onAutoBlockModeChange,
}: {
  autoBlockMode: AutoBlockMode;
  onAutoBlockModeChange: (mode: AutoBlockMode) => void;
}) {
  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>Large Loss Cases And Alternatives</h3>
          <p>Before live trading, these conditions should remain automatic block rules.</p>
        </div>
        <AutoBlockToggle mode={autoBlockMode} onChange={onAutoBlockModeChange} />
      </div>
      <div className="logic-grid">
        <InfoTile title="Overfitting" value="A strategy that looked good in history can fail live. Use walk-forward and out-of-sample validation." />
        <InfoTile title="Slippage / Fees" value="Fast strategies are sensitive to fill cost. Keep conservative fee and slippage assumptions." />
        <InfoTile title="Crash / Gap" value="Stop orders may fill worse than expected. Use max loss, daily loss limits, and emergency stop behavior." />
        <InfoTile title="Duplicate Orders" value="Loop or retry bugs can repeat orders. Use audit logs and idempotent execution before live trading." />
        <InfoTile title="Data Delay" value="Bad or delayed candles can flip signals. Validate data freshness and reject outliers." />
        <InfoTile title="Manipulation Risk" value="Anomaly signals can reverse quickly. Block overextended entries and use time stops." />
      </div>
    </section>
  );
}

function NoticePanel({ title, value }: { title: string; value: string }) {
  return (
    <section className="notice-panel">
      <strong>{title}</strong>
      <span>{value}</span>
    </section>
  );
}

function InfoTile({ title, value }: { title: string; value: string }) {
  return (
    <article className="info-tile">
      <strong>{title}</strong>
      <p>{value}</p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} type="button">
      {label}
    </button>
  );
}

function IntervalControls({
  compact = false,
  interval,
  label,
  onChange,
}: {
  compact?: boolean;
  interval: ChartInterval;
  label: string;
  onChange: (interval: ChartInterval) => void;
}) {
  const normalized = normalizeChartInterval(interval);
  const selectedPreset = chartIntervalPresets.find((preset) => isSameInterval(preset.interval, normalized));

  return (
    <div className={compact ? "interval-controls interval-controls--compact" : "interval-controls"}>
      <label>{label}</label>
      <select
        aria-label={`${label} interval preset`}
        onChange={(event) => {
          const preset = chartIntervalPresets.find((item) => item.value === event.target.value);
          if (preset) onChange(preset.interval);
        }}
        value={selectedPreset?.value ?? "5m"}
      >
        {chartIntervalPresets.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label} / {preset.windowLabel}
          </option>
        ))}
      </select>
    </div>
  );
}

function RefreshOverlay({ status }: { status: StrategyRefreshStatus }) {
  return (
    <div className="refresh-overlay" role="status" aria-live="polite">
      <div className="refresh-dialog">
        <div className="section-head">
          <div>
            <p className="eyebrow">Strategy Refresh</p>
            <h3>Strategy refresh running</h3>
            <p>
              {status.stepIndex}/{status.totalSteps} - {status.stepLabel}
            </p>
          </div>
          <strong>{status.progress}%</strong>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${status.progress}%` }} />
        </div>
        <div className="refresh-log">
          {status.logs.slice(-8).map((line, index) => (
            <span key={`${line}-${index}`}>{line}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildCaseComparisonRows(
  guideModeComparisons: StrategyGuideModeComparison[],
  candlesByMarket: Record<string, Candle[]>,
): CaseComparisonRow[] {
  return guideModeComparisons.map((comparison) => {
    const cases = [
      buildCaseMetric(comparison.strict.bestResult, "enabled", candlesByMarket),
      buildCaseMetric(comparison.strict.bestResult, "disabled", candlesByMarket),
      buildCaseMetric(comparison.ignored.bestResult, "enabled", candlesByMarket),
      buildCaseMetric(comparison.ignored.bestResult, "disabled", candlesByMarket),
    ];
    const bestCase = cases.reduce((best, current) => (scoreCaseMetric(current) > scoreCaseMetric(best) ? current : best));

    return {
      bestCase,
      cases,
      strategyName: comparison.strategyName,
    };
  });
}

function buildCaseMetric(
  result: BacktestResult,
  autoBlockMode: AutoBlockMode,
  candlesByMarket: Record<string, Candle[]>,
): CaseMetric {
  if (autoBlockMode === "disabled") {
    return {
      autoBlockMode,
      blocked: 0,
      guideMode: result.guideRuleMode,
      label: `${formatGuideModeLabel(result.guideRuleMode)} / Safety X`,
      maxDrawdown: result.maxDrawdown,
      returnRate: result.returnRate,
      trades: result.tradeCount,
    };
  }

  const candles = candlesByMarket[result.market] ?? [];
  const rawTrades = result.trades.slice().sort((a, b) => a.timestamp - b.timestamp);
  const safeTrades = filterMarketTradesBySafety(rawTrades, result, candles, "enabled");
  const equity = rebuildSingleMarketEquityCurve(result, safeTrades, candles);
  const initialCash = getResultInitialCash(result);
  const finalValue = equity[equity.length - 1]?.value ?? initialCash;

  return {
    autoBlockMode,
    blocked: countBlockedBuysBySafety(rawTrades, result, candles),
    guideMode: result.guideRuleMode,
    label: `${formatGuideModeLabel(result.guideRuleMode)} / Safety O`,
    maxDrawdown: getEquityMaxDrawdown(equity),
    returnRate: initialCash === 0 ? 0 : (finalValue - initialCash) / initialCash,
    trades: safeTrades.length,
  };
}

function rebuildSingleMarketEquityCurve(result: BacktestResult, trades: Trade[], candles: Candle[]) {
  const initialCash = getResultInitialCash(result);
  const sortedTrades = trades.slice().sort((a, b) => a.timestamp - b.timestamp);
  let tradeIndex = 0;
  let cash = initialCash;
  let position: { quantity: number } | null = null;

  return candles.map((candle) => {
    while (tradeIndex < sortedTrades.length && sortedTrades[tradeIndex].timestamp <= candle.timestamp) {
      const trade = sortedTrades[tradeIndex];
      if (trade.side === "buy" && !position) {
        cash -= trade.price * trade.quantity + trade.fee;
        position = { quantity: trade.quantity };
      } else if (trade.side === "sell" && position) {
        cash += trade.price * trade.quantity - trade.fee;
        position = null;
      }
      tradeIndex += 1;
    }

    return {
      timestamp: candle.timestamp,
      value: cash + (position ? position.quantity * candle.close : 0),
    };
  });
}

function getResultInitialCash(result: BacktestResult) {
  return result.equityCurve[0]?.value && result.equityCurve[0].value > 0
    ? Math.max(defaultBacktestConfig.initialCash, Math.round(result.equityCurve[0].value))
    : defaultBacktestConfig.initialCash;
}

function getEquityMaxDrawdown(equity: Array<{ value: number }>) {
  let peak = equity[0]?.value ?? 0;
  let maxDrawdown = 0;
  for (const point of equity) {
    peak = Math.max(peak, point.value);
    maxDrawdown = Math.max(maxDrawdown, peak === 0 ? 0 : (peak - point.value) / peak);
  }
  return maxDrawdown;
}

function scoreCaseMetric(metric: CaseMetric) {
  return metric.returnRate - metric.maxDrawdown * 1.5 - metric.blocked * 0.0002;
}

function buildDailyEntries(
  plan: TraderOptimizationPlan | undefined,
  candlesByMarket: Record<string, Candle[]>,
  autoBlockMode: AutoBlockMode,
  paperResult?: DailyPaperResult,
): DailyEntry[] {
  return (
    plan?.selectedMarkets
      .map((item, index) => ({
        label: `Pick ${index + 1} / ${item.bestResult.scenarioName ?? item.bestResult.scenarioId}`,
        market: item.market,
        result: item.bestResult,
        candles: candlesByMarket[item.market] ?? [],
      }))
      .filter((item) => item.candles.length > 0)
      .map((item) => {
        const dayStart = getKstDayStartForCandles(item.candles);
        const dailyCandles = filterCandlesSince(item.candles, dayStart);
        const currentReturn = getCandleReturn(dailyCandles);
        const autoBlock = evaluateAutoBlock(item.result, item.candles, currentReturn);
        const signal = applyAutoBlock(buildSignalFromResult(item.result), autoBlockMode, autoBlock);
        const rawTrades = (paperResult?.trades ?? item.result.trades ?? []).filter((trade) => trade.market === item.market);
        const dailyRawTrades = filterTradesSince(rawTrades, dayStart);
        const blockedSignals = filterBlockedSignalsSince(
          paperResult?.blockedSignals?.filter((signal) => signal.market === item.market) ?? [],
          dayStart,
        );
        const trades = paperResult?.autoBlockMode ? dailyRawTrades : filterMarketTradesBySafety(dailyRawTrades, item.result, item.candles, autoBlockMode);
        const paperReturn = getMarketPaperReturn(trades, dailyCandles);
        const blockedBuyCount = paperResult?.blockedSignals
          ? blockedSignals.filter((signal) => signal.reason === "safety").length
          : autoBlockMode === "enabled" ? countBlockedBuysBySafety(dailyRawTrades, item.result, item.candles) : 0;
        const tradeSummary = buildTradeSummary(trades, blockedBuyCount, paperReturn);

        return {
          ...item,
          candles: item.candles, // all candles (pre-midnight + today) for chart continuity
          dayStartMs: dayStart,
          autoBlock,
          blockedSignals,
          blockedBuyCount,
          currentReturn,
          paperReturn,
          rawTrades: dailyRawTrades,
          signal,
          tradeSummary,
          trades,
        };
      })
      .sort(compareDailyEntries) ?? []
  );
}

function compareDailyEntries(a: DailyEntry, b: DailyEntry) {
  const aHasTrades = a.trades.length > 0 ? 1 : 0;
  const bHasTrades = b.trades.length > 0 ? 1 : 0;
  if (aHasTrades !== bHasTrades) return bHasTrades - aHasTrades;
  if (a.paperReturn !== b.paperReturn) return b.paperReturn - a.paperReturn;
  return b.currentReturn - a.currentReturn;
}

function buildTradeSummary(trades: Trade[], blocked: number, returnRate: number): TradeSummary {
  return {
    blocked,
    buys: trades.filter((trade) => trade.side === "buy").length,
    returnRate,
    sells: trades.filter((trade) => trade.side === "sell").length,
  };
}

function formatTradeSummary(summary: TradeSummary) {
  return `BUY ${summary.buys} / SELL ${summary.sells} / BLOCK ${summary.blocked} / ${formatPct(summary.returnRate)}`;
}

function buildDailyOperationSummary(
  entries: DailyEntry[],
  paperResult: DailyPaperResult | undefined,
  plan: TraderOptimizationPlan | undefined,
  candlesByMarket: Record<string, Candle[]>,
  autoBlockMode: AutoBlockMode,
) {
  const bestEntry = entries[0];
  return {
    bestMarket: shortMarket(bestEntry?.market ?? "Standby"),
    bestReturn: bestEntry?.paperReturn ?? 0,
    bestTradeSummary: bestEntry ? formatTradeSummary(bestEntry.tradeSummary) : "BUY 0 / SELL 0 / BLOCK 0 / 0.00%",
    totalReturn: getDailyOperationTotalReturn(paperResult, plan, candlesByMarket, autoBlockMode),
  };
}

function getDailyOperationTotalReturn(
  paperResult: DailyPaperResult | undefined,
  plan: TraderOptimizationPlan | undefined,
  candlesByMarket: Record<string, Candle[]>,
  autoBlockMode: AutoBlockMode,
) {
  if (!paperResult) return 0;

  const dayStart = getKstDayStartForOperation(paperResult, candlesByMarket);
  const rawTrades = filterTradesSince(filterTradesByPlan(paperResult.trades, plan), dayStart);
  const trades = autoBlockMode === "enabled" ? filterTradesBySafety(rawTrades, plan, candlesByMarket) : rawTrades;
  const equityCurve = rebuildEquityCurve(paperResult, trades, candlesByMarket, dayStart);
  const last = equityCurve[equityCurve.length - 1];
  return last && paperResult.initialCash > 0 ? (last.value - paperResult.initialCash) / paperResult.initialCash : 0;
}

function buildDailySignals(entries: DailyEntry[]): DailySignal[] {
  return entries.map((entry) => entry.signal);
}

function evaluateAutoBlock(result: BacktestResult, candles: Candle[], currentReturn: number): AutoBlockEvaluation {
  const reasons: string[] = [];

  if (candles.length < 240) reasons.push("insufficient-1m-data");
  if (currentReturn <= -0.03) reasons.push("rapid-intraday-drop");
  if (currentReturn >= 0.12) reasons.push("overextended-chase-risk");
  if (result.maxDrawdown >= 0.15) reasons.push("high-max-drawdown");
  if (result.returnRate <= 0) reasons.push("non-positive-backtest");
  if (result.guideRejectedSignals >= 300) reasons.push("many-rejected-signals");

  return {
    blocked: reasons.length > 0,
    reasons,
  };
}

function applyAutoBlock(signal: DailySignal, mode: AutoBlockMode, evaluation: AutoBlockEvaluation): DailySignal {
  if (mode !== "enabled" || !evaluation.blocked || signal.action !== "buy") return signal;

  return {
    ...signal,
    action: "hold",
    qualityScore: 0,
    reasonCodes: [...signal.reasonCodes, "auto-block", ...evaluation.reasons],
    strength: 0,
  };
}

function buildSignalFromResult(result: BacktestResult): DailySignal {
  const qualityScore = clamp01(result.returnRate * 2 - result.maxDrawdown + result.winRate * 0.35);
  const strength = clamp01(result.returnRate * 2.5 + result.winRate * 0.25 + (result.tradeCount > 0 ? 0.15 : 0));
  const action = result.returnRate > 0.03 && result.maxDrawdown < 0.25 ? "buy" : result.returnRate < -0.03 ? "sell" : "hold";

  return {
    action,
    market: result.market,
    qualityScore,
    reasonCodes: [result.scenarioName ?? result.scenarioId, result.guideRuleMode],
    strength,
    timestamp: result.equityCurve[result.equityCurve.length - 1]?.timestamp ?? Date.now(),
  };
}

function getCandleReturn(candles: Candle[]) {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last || first.close === 0) return 0;
  return (last.close - first.close) / first.close;
}

function getKstDayStart(timestamp: number) {
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((timestamp + kstOffsetMs) / dayMs) * dayMs - kstOffsetMs;
}

function getKstDayStartForCandles(candles: Candle[]) {
  return getKstDayStart(candles[candles.length - 1]?.timestamp ?? Date.now());
}

function getKstDayStartForOperation(result: DailyPaperResult, candlesByMarket: Record<string, Candle[]>) {
  const latestCandleTimestamp = getLatestCandleTimestamp(candlesByMarket);
  return getKstDayStart(Math.max(result.endedAt, latestCandleTimestamp, Date.now()));
}

function getLatestCandleTimestamp(candlesByMarket: Record<string, Candle[]>) {
  return Math.max(
    0,
    ...Object.values(candlesByMarket).map((candles) => candles[candles.length - 1]?.timestamp ?? 0),
  );
}

function filterCandlesSince(candles: Candle[], since: number) {
  return candles.filter((candle) => candle.timestamp >= since);
}

function filterTradesSince<T extends Trade>(trades: T[], since: number) {
  return trades.filter((trade) => trade.timestamp >= since);
}

function filterBlockedSignalsSince<T extends BlockedSignal>(signals: T[], since: number) {
  return signals.filter((signal) => signal.timestamp >= since);
}

function getDailyReturnAtTimestamp(candles: Candle[], timestamp: number) {
  const candleIndex = findCandleIndexAtOrBefore(candles, timestamp);
  const candlesUntilTimestamp = candleIndex >= 0 ? candles.slice(0, candleIndex + 1) : candles;
  return getCandleReturn(filterCandlesSince(candlesUntilTimestamp, getKstDayStart(timestamp)));
}

function buildOperationCases(
  dailyPaperResults: DailyPaperResultsPayload | null,
  traderId: TraderId,
  plan: TraderOptimizationPlan | undefined,
  candlesByMarket: Record<string, Candle[]>,
): OperationCaseResult[] {
  const modes: GuideRuleMode[] = ["strict", "ignored"];
  const colors = ["#65c5de", "#2edc9a", "#e2a15b", "#f0848b"];
  const cases: OperationCaseResult[] = [];

  for (const guideMode of modes) {
    const result = dailyPaperResults?.results?.[guideMode]?.[traderId];
    if (!result) continue;

    const dayStart = getKstDayStartForOperation(result, candlesByMarket);
    const rawTrades = filterTradesSince(filterTradesByPlan(result.trades, plan), dayStart);
    const disabledLabel = `${formatGuideModeLabel(guideMode)} / Safety X`;
    cases.push({
      autoBlockMode: "disabled",
      color: colors[cases.length % colors.length],
      equityCurve: rebuildEquityCurve(result, rawTrades, candlesByMarket, dayStart),
      guideMode,
      initialCash: result.initialCash,
      label: disabledLabel,
      trades: rawTrades,
    });

    const safeTrades = filterTradesBySafety(rawTrades, plan, candlesByMarket);
    cases.push({
      autoBlockMode: "enabled",
      color: colors[cases.length % colors.length],
      equityCurve: rebuildEquityCurve(result, safeTrades, candlesByMarket, dayStart),
      guideMode,
      initialCash: result.initialCash,
      label: `${formatGuideModeLabel(guideMode)} / Safety O`,
      trades: safeTrades,
    });
  }

  return cases;
}

function buildOperationReturnSeries(
  cases: OperationCaseResult[],
  plan: TraderOptimizationPlan | undefined,
): TrendSeries[] {
  const selectedMarkets = new Set(plan?.selectedMarkets.map((item) => item.market) ?? []);
  const tradedMarkets = Array.from(
    new Set(
      cases.flatMap((operationCase) =>
        operationCase.trades
          .map((trade) => trade.market)
          .filter((market) => selectedMarkets.size === 0 || selectedMarkets.has(market)),
      ),
    ),
  ).sort();
  const colorByMarket = new Map(tradedMarkets.map((market, index) => [market, getMarketSeriesColor(index)]));
  const series: TrendSeries[] = [];

  for (const operationCase of cases) {
    for (const market of tradedMarkets) {
      const points = buildMarketTradeReturnPoints(operationCase.trades.filter((trade) => trade.market === market));
      if (points.length === 0) continue;

      series.push({
        color: colorByMarket.get(market) ?? getSeriesColor(series.length),
        dashArray: getOperationCaseDashArray(operationCase),
        label: `${shortMarket(market)} / ${operationCase.label}`,
        guideMode: operationCase.guideMode,
        market,
        points,
        safetyMode: operationCase.autoBlockMode,
      });
    }
  }

  return series;
}

function buildOperationBalanceSeries(cases: OperationCaseResult[]): TrendSeries[] {
  return cases.map((operationCase) => ({
    color: operationCase.color,
    label: operationCase.label,
    points: operationCase.equityCurve
      .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
      .map((point) => ({ timestamp: point.timestamp, value: point.value })),
  }));
}

function filterTradesByPlan(trades: Trade[], plan: TraderOptimizationPlan | undefined) {
  const selectedMarkets = new Set(plan?.selectedMarkets.map((item) => item.market) ?? []);
  return trades
    .filter((trade) => selectedMarkets.size === 0 || selectedMarkets.has(trade.market))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
}

function filterTradesBySafety(
  trades: Trade[],
  plan: TraderOptimizationPlan | undefined,
  candlesByMarket: Record<string, Candle[]>,
) {
  const resultByMarket = new Map(plan?.selectedMarkets.map((item) => [item.market, item.bestResult]) ?? []);
  const safeTrades: Trade[] = [];
  let includedPositionMarket: string | null = null;

  for (const trade of trades.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side === "buy") {
      const result = resultByMarket.get(trade.market);
      const candles = candlesByMarket[trade.market] ?? [];
      const candleIndex = findCandleIndexAtOrBefore(candles, trade.timestamp);
      const candlesUntilTrade = candleIndex >= 0 ? candles.slice(0, candleIndex + 1) : candles;
      const currentReturn = getDailyReturnAtTimestamp(candles, trade.timestamp);
      const blocked = result ? evaluateAutoBlock(result, candlesUntilTrade, currentReturn).blocked : false;

      if (blocked) {
        includedPositionMarket = null;
        continue;
      }

      includedPositionMarket = trade.market;
      safeTrades.push(trade);
      continue;
    }

    if (includedPositionMarket === trade.market) {
      safeTrades.push(trade);
      includedPositionMarket = null;
    }
  }

  return safeTrades;
}

function filterMarketTradesBySafety(
  trades: Trade[],
  result: BacktestResult,
  candles: Candle[],
  autoBlockMode: AutoBlockMode,
) {
  if (autoBlockMode === "disabled") return trades.slice().sort((a, b) => a.timestamp - b.timestamp);

  const safeTrades: Trade[] = [];
  let includesOpenPosition = false;

  for (const trade of trades.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side === "buy") {
      const candleIndex = findCandleIndexAtOrBefore(candles, trade.timestamp);
      const candlesUntilTrade = candleIndex >= 0 ? candles.slice(0, candleIndex + 1) : candles;
      const currentReturn = getDailyReturnAtTimestamp(candles, trade.timestamp);
      const blocked = evaluateAutoBlock(result, candlesUntilTrade, currentReturn).blocked;

      includesOpenPosition = !blocked;
      if (!blocked) safeTrades.push(trade);
      continue;
    }

    if (includesOpenPosition) {
      safeTrades.push(trade);
      includesOpenPosition = false;
    }
  }

  return safeTrades;
}

function countBlockedBuysBySafety(trades: Trade[], result: BacktestResult, candles: Candle[]) {
  let blocked = 0;

  for (const trade of trades.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side !== "buy") continue;

    const candleIndex = findCandleIndexAtOrBefore(candles, trade.timestamp);
    const candlesUntilTrade = candleIndex >= 0 ? candles.slice(0, candleIndex + 1) : candles;
    const currentReturn = getDailyReturnAtTimestamp(candles, trade.timestamp);
    if (evaluateAutoBlock(result, candlesUntilTrade, currentReturn).blocked) blocked += 1;
  }

  return blocked;
}

function getMarketPaperReturn(trades: Trade[], candles: Candle[]) {
  let cumulativeReturn = 0;
  let openTrade: Trade | null = null;

  for (const trade of trades.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side === "buy") {
      openTrade = trade;
      continue;
    }

    if (openTrade) {
      cumulativeReturn += getTradeReturn(openTrade, trade);
      openTrade = null;
    }
  }

  const last = candles[candles.length - 1];
  if (openTrade && last) {
    const entryCost = openTrade.price * openTrade.quantity + openTrade.fee;
    const markValue = last.close * openTrade.quantity;
    cumulativeReturn += entryCost === 0 ? 0 : (markValue - entryCost) / entryCost;
  }

  return cumulativeReturn;
}

function rebuildEquityCurve(
  result: DailyPaperResult,
  trades: Trade[],
  candlesByMarket: Record<string, Candle[]>,
  fromTimestamp = -Infinity,
) {
  const sortedTrades = trades.slice().sort((a, b) => a.timestamp - b.timestamp);
  let tradeIndex = 0;
  let cash = result.initialCash;
  let position: { market: string; quantity: number } | null = null;

  return result.equityCurve.filter((point) => point.timestamp >= fromTimestamp).map((point) => {
    while (tradeIndex < sortedTrades.length && sortedTrades[tradeIndex].timestamp <= point.timestamp) {
      const trade = sortedTrades[tradeIndex];
      if (trade.side === "buy" && !position) {
        cash -= trade.price * trade.quantity + trade.fee;
        position = { market: trade.market, quantity: trade.quantity };
      } else if (trade.side === "sell" && position?.market === trade.market) {
        cash += trade.price * trade.quantity - trade.fee;
        position = null;
      }
      tradeIndex += 1;
    }

    const currentPrice = position ? findCandleAtOrBefore(candlesByMarket[position.market] ?? [], point.timestamp)?.close ?? 0 : 0;
    return {
      timestamp: point.timestamp,
      value: cash + (position ? position.quantity * currentPrice : 0),
    };
  });
}

function buildMarketTradeReturnPoints(trades: Trade[]) {
  const points: Array<{ timestamp: number; value: number }> = [];
  let openTrade: Trade | null = null;
  let cumulativeReturn = 0;

  for (const trade of trades.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    if (trade.side === "buy") {
      openTrade = trade;
      if (points.length === 0) points.push({ timestamp: trade.timestamp, value: cumulativeReturn });
      continue;
    }

    if (openTrade) {
      cumulativeReturn += getTradeReturn(openTrade, trade);
      points.push({ timestamp: trade.timestamp, value: cumulativeReturn });
      openTrade = null;
    }
  }

  return points;
}

function getTradeReturn(buy: Trade, sell: Trade) {
  const entryCost = buy.price * buy.quantity + buy.fee;
  const exitValue = sell.price * sell.quantity - sell.fee;
  return entryCost === 0 ? 0 : (exitValue - entryCost) / entryCost;
}

function findCandleIndexAtOrBefore(candles: Candle[], timestamp: number) {
  let selected = -1;
  for (let index = 0; index < candles.length; index += 1) {
    if (candles[index].timestamp > timestamp) break;
    selected = index;
  }
  return selected;
}

function findCandleAtOrBefore(candles: Candle[], timestamp: number) {
  const index = findCandleIndexAtOrBefore(candles, timestamp);
  return index >= 0 ? candles[index] : null;
}

function formatGuideModeLabel(mode: GuideRuleMode) {
  return mode === "strict" ? "Guideline O" : "Guideline X";
}

function toTrendPoint(
  point: { timestamp: number; value: number },
  minTime: number,
  maxTime: number,
  minValue: number,
  maxValue: number,
  width: number,
  height: number,
  padding: { bottom: number; left: number; right: number; top: number },
) {
  const xRange = Math.max(1, maxTime - minTime);
  const yRange = Math.max(0.000001, maxValue - minValue);
  const x = padding.left + ((point.timestamp - minTime) / xRange) * (width - padding.left - padding.right);
  const y = height - padding.bottom - ((point.value - minValue) / yRange) * (height - padding.top - padding.bottom);
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function buildTrendTicks(minValue: number, maxValue: number, count: number) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return [];
  if (count <= 1 || minValue === maxValue) return [minValue];

  return Array.from({ length: count }, (_, index) => minValue + ((maxValue - minValue) * index) / (count - 1));
}

function getSeriesColor(index: number) {
  return ["#65c5de", "#e2a15b", "#70d39f", "#f0848b"][index % 4];
}

function getMarketSeriesColor(index: number) {
  return [
    "#65c5de",
    "#e2a15b",
    "#70d39f",
    "#f0848b",
    "#b59cff",
    "#f2cf5b",
    "#4fd1c5",
    "#f59fb6",
    "#9bd66f",
    "#8fb8ff",
    "#d6a0ff",
    "#ffb86b",
  ][index % 12];
}

function getOperationCaseDashArray(operationCase: Pick<OperationCaseResult, "autoBlockMode" | "guideMode">) {
  if (operationCase.guideMode === "strict" && operationCase.autoBlockMode === "enabled") return undefined;
  if (operationCase.guideMode === "strict" && operationCase.autoBlockMode === "disabled") return "12 7";
  if (operationCase.guideMode === "ignored" && operationCase.autoBlockMode === "enabled") return "3 6";
  return "10 5 2 5";
}

function exportScenarioPayload(name: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload ?? { status: "empty" }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function buildGuidelineExportPayload() {
  return {
    modes: ["strict", "ignored"],
    strictSummary: [
      "trend structure",
      "moving averages",
      "support and resistance",
      "candlestick warnings",
      "risk controls",
    ],
    ignoredSummary: "raw strategy signal only",
  };
}

function getScreenTitle(screenId: ScreenId) {
  return menuSections.flatMap((section) => section.items).find((item) => item.id === screenId)?.label ?? "Dashboard";
}

function loadStoredScreenId(): ScreenId {
  if (typeof window === "undefined") return "report-anomaly";
  const stored = window.localStorage.getItem(screenStorageKey);
  return isScreenId(stored) ? stored : "report-anomaly";
}

function isScreenId(value: unknown): value is ScreenId {
  return typeof value === "string" && screenIds.includes(value as ScreenId);
}

function getScreenKicker(screenId: ScreenId) {
  if (screenId.startsWith("scenario")) return "전략 개요";
  if (screenId.startsWith("report")) return "시뮬레이션 결과";
  if (screenId.startsWith("daily")) return "Daily 운영";
  return "";
}

function isSameInterval(a: ChartInterval, b: ChartInterval) {
  return a.value === b.value && a.unit === b.unit;
}

function isDailyScreenId(value: ScreenId): value is keyof typeof dailyScreens {
  return value in dailyScreens;
}

function formatDailyDecision(action: string, buyMarket?: string, sellMarket?: string) {
  if (action === "buy") return `BUY ${buyMarket}`;
  if (action === "sell") return `SELL ${sellMarket}`;
  if (action === "rotate") return `ROTATE ${sellMarket} -> ${buyMarket}`;
  return "HOLD";
}

function formatGeneratedAt(value: string) {
  if (!value) return "N/A";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeZone: "Asia/Seoul",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatTradeTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(timestamp));
}

function formatHour(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(timestamp));
}

function formatProfitFactor(value: number) {
  if (!Number.isFinite(value)) return "Infinite";
  return value.toFixed(2);
}

function shortMarket(market: string) {
  return market.startsWith("KRW-") ? market.slice(4) : market;
}

function shortStrategyName(id: TraderId) {
  if (id === "momentum") return "Anomaly-A";
  if (id === "range-grid") return "Anomaly-B";
  if (id === "arbitrage") return "Anomaly-C";
  return "Anomaly-D";
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
