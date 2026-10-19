const principles = [
  { title: "고객사별 데이터 분리", description: "각 회사가 자신의 창고와 품목을 독립적으로 관리합니다." },
  { title: "정확한 재고 처리", description: "입고·출고·이동을 전표로 연결하고 재고 변화를 검증합니다." },
  { title: "추적 가능한 작업이력", description: "누가, 언제, 어떤 작업으로 재고를 변경했는지 확인합니다." },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
      <p className="text-sm font-semibold tracking-widest text-slate-500">WAREHOUSE MANAGEMENT</p>
      <h1 className="mt-4 text-5xl font-bold tracking-tight">WMS Lite</h1>
      <p className="mt-6 max-w-2xl text-xl leading-relaxed text-slate-600">고객사별 물류·창고 운영관리</p>
      <section aria-label="개발 진행 상태" className="mt-10 rounded-2xl border border-blue-200 bg-blue-50 p-6">
        <h2 className="font-semibold text-blue-950">개발 환경 구성 단계</h2>
        <p data-testid="development-status" className="mt-2 leading-relaxed text-blue-900">현재 초기 개발 단계입니다. 로그인과 입출고·재고 관리 기능은 순차적으로 구현할 예정입니다.</p>
      </section>
      <section aria-label="프로젝트 목표" className="mt-8 grid gap-5 md:grid-cols-3">
        {principles.map((principle) => (
          <article key={principle.title} className="rounded-2xl border border-slate-200 bg-white p-6">
            <h2 className="font-semibold">{principle.title}</h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">{principle.description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
