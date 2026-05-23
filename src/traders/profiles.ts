import type { TraderId } from "../types/trading";

export interface TraderProfile {
  id: TraderId;
  name: string;
  summary: string;
  strengths: string[];
  risks: string[];
}

export const traderProfiles: TraderProfile[] = [
  {
    id: "momentum",
    name: "Anomaly-A / Calm Impulse",
    summary: "15봉 이상 조용한 구간 이후 첫 번째 충동적 상승을 포착합니다. 평균 거래량 대비 1.5× 이상 + 1% 바디 조건.",
    strengths: ["낮은 노이즈 환경에서 정확", "짧은 보유(12봉)", "급격한 변동 전 초기 진입"],
    risks: ["신호 빈도 낮음", "횡보 구간 오진", "빠른 청산으로 수익 제한"],
  },
  {
    id: "range-grid",
    name: "Anomaly-B / First Explosion",
    summary: "거래량 3.5× 이상 + 바디 2.5% 이상의 폭발적 상승 캔들 자체에 진입합니다. 3봉 선행 조용함 필수.",
    strengths: ["폭발 시점 직접 포착", "짧은 보유(6봉)로 리스크 최소화", "높은 win-rate(소수 거래)"],
    risks: ["매우 낮은 발화 빈도", "슬리피지 위험", "가짜 폭발 오진"],
  },
  {
    id: "arbitrage",
    name: "Anomaly-C / Confirmed Burst",
    summary: "폭발 캔들 다음 봉에서 거래량 1.8× + 상승 유지를 확인 후 진입합니다. 확인 지연 대신 신뢰도 향상.",
    strengths: ["이중 확인으로 오진 감소", "추세 지속 시 추가 수익", "역방향 포지션 위험 감소"],
    risks: ["진입 지연으로 일부 수익 포기", "확인봉에서 이미 고점", "낮은 발화 빈도"],
  },
  {
    id: "anomaly",
    name: "Anomaly-D / Sweep Best",
    summary: "기존 특이점 전략에 최적화된 trailingStop(0.018)을 적용한 베이스라인입니다. 비교 기준점 역할.",
    strengths: ["다양한 시장 조건 대응", "trailing stop으로 수익 보호", "9개 감시 종목 집중 커버"],
    risks: ["높은 거짓 신호율", "급락과 슬리피지", "시장 조작 위험"],
  },
];
