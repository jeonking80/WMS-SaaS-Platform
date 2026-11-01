/** Render the 14-section portfolio from the repository's real design, code and captured screens.
 * Does not contact the application or any external AI. Code excerpts are read from a pinned commit. */
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';

const sourceCommit='ca8c38940ae090f0cba24d36ab03203f2be80d0e';
const repo='https://github.com/jeonking80/WMS-SaaS-Platform';
const docsBase='https://github.com/jeonking80/portfolio/blob/main/WMS';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'public/portfolio');await mkdir(output,{recursive:true});
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const asset=async name=>'data:image/png;base64,'+(await readFile(resolve(root,'docs/assets/portfolio',name+'.png'))).toString('base64');
const fig=async(name,caption,cls='')=>`<figure class="${cls}"><div class="shot"><img src="${await asset(name)}" alt="${esc(caption)}"></div><figcaption>${caption}</figcaption></figure>`;
const point=(title,text)=>`<div class="point"><h3>${title}</h3><p>${text}</p></div>`;
const tag=s=>`<span class="tag">${s}</span>`;
const source=path=>execFileSync('git',['show',`${sourceCommit}:${path}`],{cwd:root,encoding:'utf8'});
const pages=[];
function page(no,section,title,sub,body,cls=''){
  pages.push(`<section class="page ${cls}"><header><div class="eyebrow"><b>${String(no).padStart(2,'0')}</b> ${section}</div><h1>${title}</h1>${sub?`<p class="subtitle">${sub}</p>`:''}</header><div class="page-body">${body}</div><footer><span>WMS Lite 포트폴리오 · 전우석</span><span>__PAGE__</span></footer></section>`);
}

/* 1. 표지 */
pages.push(`<section class="page cover"><div class="cover-text"><div class="eyebrow"><b>PORTFOLIO</b> 고객사별 창고 운영관리 SaaS</div><div class="cover-name">WMS Lite</div><p class="lead">입고부터 출하·반품까지, 실물·잔량·담당자를<br>서버 규칙과 지울 수 없는 원장으로 연결한 웹 창고 운영 시스템</p><div class="tags">${['Next.js 16','React 19','TypeScript','PostgreSQL · RLS','Better Auth','Vercel + Neon','Playwright · Vitest','Claude API'].map(tag).join('')}</div><dl class="cover-meta"><dt>작성자</dt><dd>전우석</dd><dt>개발 기간</dt><dd>2일 (기획·규칙 결정·검증 주도, AI 도구로 구현)</dd><dt>형태</dt><dd>1인 프로젝트 · 공개 저장소 · 공개 데모</dd></dl></div>${await fig('01-control-tower','운영 관제 화면 · 로컬 실행 · 합성 데이터','cover-shot')}<footer><span>WMS Lite 포트폴리오 · 전우석</span><span>__PAGE__</span></footer></section>`);

/* 2. 프로젝트 개요 */
page(2,'프로젝트 개요','여러 고객사가 한 서비스에서 창고를 운영합니다','“재고가 있다”와 “출고할 수 있다”를 구분하고, 모든 수량 변화를 누가·왜 했는지까지 남기는 것이 목표입니다.',`
<div class="overview"><div><h2 class="h2">무엇을 하는 시스템인가</h2><p>회사(고객사)마다 창고·위치·품목·거래처를 등록하고, <b>입고 → 검수 → 적치</b>, <b>주문 → 예약 → 피킹 → 포장 → 인계·배송</b>, <b>반품·실사·승인·교대 마감</b>을 처리합니다. 외부 시스템은 연계 API로 주문·입고 사건을 보내고, 관리자는 운영 관제 화면과 읽기 전용 AI 도우미로 위험을 찾습니다.</p>
<h2 class="h2">핵심 규칙 3개</h2><ol class="rules"><li><b>재고는 덮어쓰지 않는다</b><span>모든 증감은 UPDATE·DELETE가 막힌 원장에 한 줄씩 쌓고, 현재고가 원장 합계와 같을 때만 다음 명령을 실행합니다.</span></li><li><b>같은 요청은 한 번만 반영한다</b><span>화면이 만든 request_id로 응답이 끊긴 재시도도 같은 결과를 돌려주고, 내용이 다르면 거절합니다.</span></li><li><b>권한 경계와 승인 분리</b><span>회사·창고·역할을 서버와 DB(RLS)가 이중으로 검사하고, 과납·실사 차이·정정은 요청자와 다른 사람이 승인합니다.</span></li></ol></div>
<div><h2 class="h2">규모</h2><div class="metrics">
<div><strong>41</strong><span>DB 테이블<br><small>SQL 마이그레이션 22개</small></span></div>
<div><strong>40</strong><span>업무 명령<br><small>receipt.receive 등</small></span></div>
<div><strong>51</strong><span>API 라우트<br><small>사람·기계 키 공용</small></span></div>
<div><strong>19</strong><span>화면<br><small>현장 운영 12 · 기존 7</small></span></div>
<div><strong>696</strong><span>자동화 테스트<br><small>단위·통합·브라우저 등</small></span></div>
<div><strong>7</strong><span>재고 지표<br><small>H·S·A·R·P·Q·B</small></span></div></div>
<div class="note">재고 7지표: 총실물 H = 정상보관 S + 피킹 P + 검수·적치 Q + 보류 B. 예약 R은 S 안에 포함되고, 가용 A는 예약과 위치 잠금을 뺀 수량입니다.</div></div></div>
<div class="band"><div><h3>처리 범위</h3><p>${['기준정보·CSV','입고·검수·적치','출고·예약·피킹·포장·배송','반품','실사·승인','교대·일일 마감','외부 연계','운영 관제·AI','기존 창고 전환'].map(tag).join('')}</p></div><div><h3>사용자와 역할</h3><p><b>회사 관리자</b> 계정·권한·기준정보·승인 · <b>운영 책임자</b> 배정·예외·승인 · <b>작업자</b> 수령부터 출하까지 실물 처리 · <b>조회자</b> 조회만</p></div></div>`);

/* 3. 시스템 아키텍처 */
page(3,'시스템 아키텍처','업무 규칙과 권한 검사는 모두 서버에 있습니다','화면은 안내만 하고, 수량·상태·권한은 서버와 DB가 다시 검사합니다. 서버 함수와 DB는 같은 싱가포르 지역에 둡니다.',`
<div class="arch">
 <div class="arch-col"><div class="arch-label">사용자</div><div class="box">현장 작업자 · 책임자<br><small>현장 운영 화면 (React 19)</small></div><div class="box">회사 관리자 · 조회자<br><small>운영 관제 · 기존 화면</small></div><div class="box ext">가상 데이터 시뮬레이터<br><small>별도 Node 24 앱 · SQLite</small></div></div>
 <div class="arch-arrow">HTTPS<br>JSON →</div>
 <div class="arch-col wide"><div class="arch-label">Vercel 서버 함수 (sin1) · Next.js 16</div>
  <div class="box layer">① 요청 출처 확인 · 요청 기록(request_id)</div>
  <div class="box layer">② 인증: Better Auth 세션 + 유휴 잠금 / 기계 키 SHA-256</div>
  <div class="box layer">③ 권한: 회사 멤버십 · 창고 허가 · 역할을 매 요청 DB에서 다시 읽음</div>
  <div class="arch-split"><div class="box core">④ 업무 처리<br><small>트랜잭션 · 잠금 · 멱등 · 대사</small></div><div class="box core">상태 전이 엔진<br><small>engine.ts · DB를 모르는 순수 함수</small></div></div>
  <div class="arch-split"><div class="box">관제 집계 · 품절 예측</div><div class="box">AI 도우미 · 읽기 전용 도구 7개</div></div></div>
 <div class="arch-arrow">SQL<br>→</div>
 <div class="arch-col"><div class="arch-label">Neon PostgreSQL (싱가포르)</div><div class="box db">회사별 RLS (FORCE)<br><small>앱 계정 NOBYPASSRLS</small></div><div class="box db">업무 상태 · 현재고</div><div class="box db">불변 원장 · 요청 결과<br><small>변경·삭제 금지 트리거</small></div><div class="arch-label second">외부</div><div class="box ext">Claude API<br><small>도구 결과만 전달 · 쓰기 도구 없음</small></div></div>
</div>
<div class="arch-notes">${point('한 앱에 화면과 API','화면은 src/app/dashboard, API는 src/app/api 아래 51개 라우트입니다. 서버 컴포넌트에서 세션을 확인해 로그인 화면으로 보냅니다.')}${point('엔진을 DB와 분리','“현재 상태 + 명령 → 새 상태 + 원장 행”만 계산하므로 DB 없이 단위 테스트로 업무 규칙 40개 명령을 검사합니다.')}${point('외부 연계도 같은 문','시뮬레이터와 외부 시스템은 회사·창고·범위가 묶인 기계 키로 같은 API와 같은 권한 검사를 거칩니다.')}</div>`);

/* 4. 기술 스택과 선택 이유 */
page(4,'기술 스택과 선택 이유','계층마다 “무엇을 막기 위해” 골랐는지 정리했습니다','',`
<table class="stack-table"><tr><th>계층</th><th>선택</th><th>선택 이유</th><th>대안과 대가</th></tr>
<tr><td>화면·API</td><td>Next.js 16 App Router<br>React 19</td><td>화면과 API를 한 저장소·한 배포로 관리. 서버 컴포넌트에서 세션을 확인해 페이지 단위 보호</td><td>프레임워크 변경이 잦아 버전별 문서를 확인하며 작성</td></tr>
<tr><td>언어</td><td>TypeScript 7</td><td>명령 페이로드·업무 상태 타입을 화면·서버·엔진이 공유해 필드 누락을 컴파일 단계에서 발견</td><td>—</td></tr>
<tr><td>DB</td><td>PostgreSQL</td><td>트랜잭션·행 잠금·advisory lock·RLS를 DB가 보장. 동시 예약과 회사 간 노출을 앱 코드만 믿지 않고 막음</td><td>회사별 DB 분리보다 격리는 약하지만 운영 비용이 낮음 → RLS FORCE로 보완</td></tr>
<tr><td>스키마</td><td>node-pg-migrate · SQL</td><td>RLS 정책·불변 트리거·인덱스를 SQL로 명시하고 22개 마이그레이션으로 이력 관리</td><td>ORM 편의 기능 대신 SQL을 직접 검토</td></tr>
<tr><td>인증</td><td>Better Auth</td><td>세션·초대·비밀번호 재설정을 직접 구현하지 않음. 보호 요청마다 서버에서 유휴 시간 검사</td><td>세션 확인에 DB 왕복이 추가됨</td></tr>
<tr><td>배포</td><td>Vercel(sin1) + Neon</td><td>무료 공개 데모. 서버 함수와 DB를 같은 싱가포르 지역에 두어 요청당 DB 왕복 지연 최소화</td><td>Neon 무료 요금제는 5분 유휴 시 DB가 잠들어 첫 요청이 느림</td></tr>
<tr><td>AI</td><td>Claude API 도구 호출</td><td>현재 창고 데이터로 답하되 읽기 전용 도구 7개만 제공해 재고 변경 경로를 원천 차단</td><td>API 키가 없으면 빠른 질문은 같은 도구를 직접 실행</td></tr>
<tr><td>검증</td><td>Vitest · Playwright · node:test</td><td>단위(엔진·권한)·실제 PostgreSQL 통합·실제 브라우저 흐름을 한 명령(npm run verify)으로 실행</td><td>GitHub Actions 대신 로컬 검증을 원칙으로 함</td></tr>
<tr><td>시뮬레이터</td><td>Node 24 · node:sqlite</td><td>WMS 코드를 재사용하지 않는 별도 앱이 API로 업무를 보내고, 독립 기대값으로 재고·원장을 대조</td><td>시험 회사 전용, 현장 성능 검증을 대체하지 않음</td></tr></table>`);

/* 5. 데이터 모델 */
const chip=(name,desc,cls='')=>`<div class="tbl ${cls}"><b>${name}</b>${desc?`<span>${desc}</span>`:''}</div>`;
page(5,'데이터 모델','41개 테이블을 성격에 따라 네 묶음으로 나눴습니다','모든 업무 테이블에 tenant_id가 있고, 회사 경계는 RLS가 강제합니다. 아래는 핵심 테이블과 관계입니다.',`
<div class="model">
 <div class="group g1"><h3>기준정보 <small>바뀔 수 있지만 참조 중이면 비활성화 불가</small></h3>${chip('tenants','회사 · 유휴 잠금 정책')}${chip('warehouses → locations','창고 · 위치(수령·보관·보류·포장)')}${chip('items','품목 · 최소 재고')}${chip('business_partners → delivery_destinations','거래처 · 배송지')}${chip('master_barcodes','품목/위치 바코드 · 포장 수량 변경 금지')}${chip('memberships · v2_warehouse_grants','회사 역할 · 창고 허가')}${chip('v2_machine_keys','외부 연계 키 · 범위')}</div>
 <div class="group g2"><h3>현재 상태 <small>창고 단위로 잠가 갱신</small></h3>${chip('v2_workflow_state','창고별 업무 상태 헤더','key')}${chip('v2_workflow_object_state','입고예정·주문·포장·실사 등 객체 상태')}${chip('v2_workflow_stock','품목×위치의 S·R·P·Q·B 현재고','key')}${chip('v2_workflow_objects','외부번호와 객체 연결')}${chip('v2_integration_entities','외부 업무 최신 버전')}</div>
 <div class="group g3"><h3>지울 수 없는 이력 <small>UPDATE·DELETE 금지 트리거</small></h3>${chip('v2_workflow_ledger','재고 증감 한 줄씩: 품목·위치·버킷·증감·명령·작업자·사유','key')}${chip('v2_workflow_requests','request_id · 요청 해시 · 응답','key')}${chip('v2_workflow_performances','작업 실적 · 스캔 증거')}${chip('v2_workflow_receivings','수령 단위 중복 방지')}${chip('api_request_metrics','요청별 결과·처리 시간')}</div>
 <div class="group g4"><h3>운영 기록 <small>연계·계정·전환의 처리 기록</small></h3>${chip('v2_integration_events','외부 사건 · 격리 · 재처리')}${chip('v2_identity_audit','계정·권한 변경 이력')}${chip('master_csv_previews / applies','CSV 검증 미리보기 · 적용')}${chip('v2_opening_imports · v2_cutovers','개시재고 · 기존 창고 전환')}${chip('session · rateLimit','세션 · 로그인 시도 제한')}</div>
</div>
<div class="relations"><div><b>v2_workflow_ledger</b> 합계 <em>=</em> <b>v2_workflow_stock</b><span>명령 실행 전마다 대사, 다르면 실행 거부</span></div><div><b>v2_workflow_requests</b> <em>1 : N</em> <b>ledger · performances</b><span>같은 request_id로 묶여 함께 COMMIT</span></div><div><b>items · locations</b> <em>←</em> <b>stock · ledger</b><span>참조 중인 기준정보는 비활성화 거절(트리거)</span></div></div>
<div class="principles">${point('현재 상태는 “결과”, 원장은 “원인”','현재고는 빠른 조회용이고, 정답은 원장입니다. 둘이 다르면 새 명령을 받지 않고 원인을 찾게 합니다.')}${point('이력은 고치지 않고 덧붙인다','원장·요청 결과·작업 실적은 트리거로 변경을 막고, 잘못은 승인을 거친 반대 방향 실적으로 바로잡습니다.')}${point('외부 사건은 업무와 분리','연계 사건은 접수와 반영을 나눠 저장해, 순서가 뒤바뀌거나 중복돼도 업무 상태가 오염되지 않습니다.')}</div>`);

/* 6. 데이터 저장 흐름 */
const step=(n,title,detail,guard)=>`<div class="flow-step"><span class="n">${n}</span><div><b>${title}</b><p>${detail}</p></div><em>${guard}</em></div>`;
page(6,'데이터 저장 흐름','“실물 수령 확정” 요청 하나가 한 트랜잭션 안에서 처리되는 순서','POST /api/v2/workflow · executeWorkflowInTransaction · 실패하면 어느 단계든 전체 ROLLBACK',`
<div class="flow">
${step(1,'화면: request_id 생성 후 먼저 저장','UUID를 만들어 브라우저에 “결과 미확인”으로 저장하고 전송','응답이 끊겨도 같은 키로 결과 확인')}
${step(2,'API: 출처·세션·멤버십·창고 권한','유휴 잠금 검사, 역할·창고 허가를 DB에서 다시 읽음','회사 헤더 위조, 퇴사자 세션')}
${step(3,'BEGIN + RLS 문맥 설정','set_config(app.tenant_id, app.user_id …)를 BEGIN과 한 번에 전송','다른 회사 행 조회·수정')}
${step(4,'request_id 잠금','pg_advisory_xact_lock(회사ID:request_id)','같은 요청의 동시 이중 실행')}
${step(5,'창고 상태 행 잠금 + 대사','FOR UPDATE로 창고 명령을 한 줄로 세우고 원장 합계=현재고 확인','동시 예약 초과, 틀어진 상태 위의 작업')}
${step(6,'저장된 요청 조회','같은 키·같은 해시면 이전 응답 반환, 해시가 다르면 IDEMPOTENCY_CONFLICT','재시도로 인한 이중 반영')}
${step(7,'엔진 실행 (순수 함수)','applyCommand(상태, 명령) → 새 상태 + 원장 행 (예: Q +24)','수량 초과·위치 유형·버전 충돌')}
${step(8,'원장·현재고·요청 결과 저장 → COMMIT','ledger INSERT, stock 갱신, requests에 해시·응답 저장','일부만 저장되는 상태')}
${step(9,'화면: 결과 미확인 삭제 → 다음 단계','응답의 스냅샷으로 화면 갱신, 다음 할 일(검수 24 EA) 안내','—')}
</div>
<div class="principles">${point('권한에서 막히면','트랜잭션을 열기 전에 401·403으로 끝나며 DB에 업무 흔적이 남지 않습니다.')}${point('엔진에서 막히면','EXCEEDS_PENDING 같은 업무 오류와 함께 전체 ROLLBACK, 원장·현재고 변화가 없습니다.')}${point('응답만 사라지면','서버는 이미 COMMIT. 화면이 저장해 둔 같은 request_id로 다시 보내 저장된 결과를 받습니다.')}</div>
<p class="caption">단계 3은 BEGIN과 설정 쿼리를 한 번에 보내 DB 왕복을 줄인 현재 구현입니다.</p>`);

/* 7. 핵심 코드 */
const engine=source('src/server/v2/workflow/engine.ts');
const inspectStart=engine.indexOf('function inspect(');
const inspectEnd=engine.indexOf('function putaway(',inspectStart);
const changeStart=engine.indexOf('function change(');
const changeEnd=engine.indexOf('  s.ledger.push({',changeStart);
if([inspectStart,inspectEnd,changeStart,changeEnd].some(at=>at<0))throw Error('Engine excerpt boundaries missing');
const lineOf=at=>engine.slice(0,at).split('\n').length;
const inspectCode=engine.slice(inspectStart,inspectEnd).trimEnd();
const changeCode=engine.slice(changeStart,changeEnd).trimEnd()+'\n  s.ledger.push({ /* 품목·위치·버킷·증감·명령·작업자·사유 */ });\n}';
page(7,'핵심 코드','검수: “정상”은 적치 대기로, “보류”는 원장에 Q→B로 남깁니다','실제 코드 발췌 · src/server/v2/workflow/engine.ts · 고정 커밋 '+sourceCommit.slice(0,7),`
<div class="code-layout"><div><div class="code-label">inspect() · L${lineOf(inspectStart)}</div><pre class="source-code"><code>${esc(inspectCode)}</code></pre><div class="code-label">change() · L${lineOf(changeStart)} (원장 기록부 생략)</div><pre class="source-code"><code>${esc(changeCode)}</code></pre><p class="caption"><a href="${repo}/blob/${sourceCommit}/src/server/v2/workflow/engine.ts#L${lineOf(inspectStart)}">engine.ts 원문 ↗</a></p></div>
<div class="code-notes">${point('① 남은 수량을 넘지 못함','lot.pending(수령했지만 검수 전)보다 많이 검수하면 EXCEEDS_PENDING. 화면 검사가 빠져도 서버에서 거절합니다.')}${point('② 정상과 보류의 재고 효과가 다름','정상은 실물이 그대로 수령 위치에 있으므로 Q를 유지하고 적치 단계에서 Q→S로 옮깁니다. 보류는 즉시 Q−q, B+q 두 줄을 원장에 남겨 가용 재고에서 빠집니다.')}${point('③ 모든 증감은 change() 한 곳','비활성 품목, 음수 재고, 예약 R이 정상 S를 넘는 상태를 여기서 막고 원장 행을 만듭니다. 재고를 바꾸는 다른 길이 없습니다.')}${point('④ DB를 모르는 함수','같은 입력이면 같은 결과라 단위 테스트로 검수·적치·보류 해제를 검사하고, 저장·잠금은 6쪽의 트랜잭션이 맡습니다.')}</div></div>`);

/* 8. 보안·권한 구조 */
page(8,'보안·권한 구조','회사 → 창고 → 역할 → 승인 자격을 차례로 검사합니다','앞 단계를 통과해도 다음 단계에서 다시 검사합니다. 세션에 저장된 옛 역할은 믿지 않습니다.',`
<div class="split"><div><div class="layers">
<div class="sec"><b>1. 인증</b><p>Better Auth 세션. 보호 요청마다 회사 정책의 유휴 시간을 서버가 검사해 초과 세션은 삭제합니다. 외부 연계는 회사·창고·범위가 묶인 기계 키(SHA-256 해시 저장)를 씁니다.</p></div>
<div class="sec"><b>2. 회사 경계</b><p>회사는 요청 헤더가 아니라 세션 사용자의 멤버십으로 정합니다. DB는 FORCE RLS + NOBYPASSRLS 계정으로, 앱 코드가 조건을 빠뜨려도 다른 회사 행을 돌려주지 않습니다.</p></div>
<div class="sec"><b>3. 창고·역할</b><p>v2_warehouse_grants에 허가된 창고만 조회·처리합니다. 역할표: 관리자(계정·기준정보·승인) · 책임자(배정·예외·승인) · 작업자(실물 처리) · 조회자(조회만).</p></div>
<div class="sec"><b>4. 승인 분리</b><p>과납 인수·잔량 마감·실사 차이·정정은 요청자·원실적자·계수자를 제외한 다른 승인권자만 확정합니다. 대상 버전이 바뀌면 APPROVAL_STALE로 무효입니다.</p></div>
<div class="sec"><b>5. AI 경계</b><p>도우미 도구는 읽기 전용 7개뿐이고 로그인 사용자의 창고 권한으로만 조회합니다. 도구 결과의 품목명·사유는 지시가 아닌 데이터로 취급합니다.</p></div></div></div>
<div>${await fig('09-independent-approval','본인이 요청한 과납 승인: 승인 버튼이 비활성화되고 다른 승인권자 처리를 안내합니다.')}<div class="note"><b>검증으로 확인한 것</b><br>회사 A↔B 조회·전표 접근·취소 차단과 데이터 미변경, 메뉴 이동 중 세션이 끝나면 “권한 없음” 대신 로그인 화면으로 보내는 동작을 브라우저 시험으로 고정했습니다.</div></div></div>`);

/* 9. 동시성과 정합성 */
page(9,'동시성과 정합성','동시 작업과 재시도에도 재고와 원장이 어긋나지 않게','창고 단위로 명령을 한 줄로 세우는 대신, 처리량 상한을 감수했습니다.',`
<div class="split"><div><table class="guard"><tr><th>상황</th><th>장치</th><th>결과</th></tr>
<tr><td>두 작업자가 마지막 10개를 동시에 예약</td><td>창고 상태 행 FOR UPDATE</td><td>뒤 요청은 앞 요청 결과를 보고 판단 → 초과 예약 없음</td></tr>
<tr><td>확정 응답이 끊겨 다시 누름</td><td>request_id advisory lock + 요청 해시</td><td>저장된 응답 재반환(replayed), 재고 1회 반영</td></tr>
<tr><td>같은 키로 다른 수량 전송</td><td>해시 비교</td><td>IDEMPOTENCY_CONFLICT 거절</td></tr>
<tr><td>화면이 보던 업무가 그사이 변경</td><td>expected_version (낙관적 잠금)</td><td>VERSION_CONFLICT, 새로 보고 다시 처리</td></tr>
<tr><td>이미 틀어진 재고 위에 작업</td><td>명령 전 원장 합계 = 현재고 대사</td><td>실행 거부, 원인 조사부터</td></tr>
<tr><td>처리 중 오류</td><td>원장·현재고·요청 결과 단일 트랜잭션</td><td>전체 ROLLBACK, 일부 저장 없음</td></tr>
<tr><td>잘못 처리한 수량</td><td>원장 UPDATE·DELETE 금지 트리거</td><td>지우지 않고 승인 후 반대 방향 정정 실적</td></tr></table>
<div class="note"><b>대가와 기록</b> 한 창고의 처리량에 상한이 생깁니다. 혼잡 시험 기록(docs/v2-congestion-*)에 목표 미달 결과를 숨기지 않고 남겼고, 전체 상태 읽기와 잠금 대기를 병목 후보로 정리했습니다.</div></div>
<div>${await fig('10-ledger-trace','원장 조회: 품목·위치·처리 경계로 모든 증감과 작업자·사유를 추적합니다.')}${point('예약은 “전부 아니면 실패”','부족하면 운영자가 “가능 수량만 예약”을 명시적으로 고릅니다. 시스템이 몰래 일부만 잡지 않습니다.')}</div></div>`);

/* 10. 자동화와 프론트엔드 */
page(10,'자동화와 프론트엔드','사람 없이 업무를 흘려 보고, 사람은 설명 없이 쓰게','',`
<div class="split equal"><div><h2 class="h2">자동화</h2>${point('가상 데이터 시뮬레이터','Node 24·SQLite의 별도 앱이 기계 키로 연계 API를 호출해 입고·주문·운송 사건과 부족·파손·오스캔을 만듭니다. WMS 계산 코드를 쓰지 않는 독립 기대값(oracle.mjs)으로 재고·원장·원업무 수량을 대조합니다.')}${point('외부 연계 API','사건마다 버전·멱등 키를 두고 의존성 대기·업무 거절·격리를 구분합니다. 관리자는 원래 사건으로 재처리합니다.')}${point('CSV 일괄 등록','기준정보·입고예정·주문을 미리보기로 형식·참조·중복을 검사한 뒤 정상 행만 골라 적용합니다.')}${point('운영 관제·AI','원장을 집계해 처리량·납기 위험·품절 예측(최근 7일 60% + 28일 40% 가중)을 계산하고, 읽기 전용 도우미가 같은 데이터로 답합니다.')}${await fig('16-simulator-timeline','시뮬레이터 실행 타임라인 (기존 로컬 시험 캡처)','short')}</div>
<div><h2 class="h2">프론트엔드</h2>${point('스캔 우선 작업 화면','위치 → 품목 바코드 순서를 안내하고, 반복 스캔은 포장 수량만큼 누적합니다. 스캔 실패 시 검색 대체는 사유를 남깁니다.')}${point('다음 할 일과 막힌 이유','서버가 계산한 “검수할 수량 24 EA” 같은 안내를 보여 주고, 확정 버튼이 비활성이면 이유를 바로 위에 씁니다.')}${point('결과 미확인 복구','응답을 못 받은 확정이 있으면 새 작업을 막고 “원래 요청 그대로 재전송”으로 복구합니다.')}${point('공용 단말과 속도','무활동 자동 잠금, 마지막 창고를 기억해 로그인 정보와 동시에 불러오기, 기준정보 창고별 재사용, 글꼴 자체 호스팅.')}${await fig('12-tablet-control','태블릿 폭의 운영 관제','tablet')}</div></div>`);

/* 11. 업무 흐름과 주요 화면 (2쪽) */
page(11,'업무 흐름과 주요 화면 ①','입고: 예정만으로 재고를 만들지 않습니다','실제로 처리한 수량만 다음 단계로 넘기고, 단계마다 남은 수량을 유지합니다.',`
<div class="process"><div><b>입고예정</b><span>공급처·품목·예정 수량<br>재고 변화 없음</span></div><i>→</i><div><b>1 수령</b><span>실제 도착 수량<br>Q +수령</span></div><i>→</i><div><b>2 검수</b><span>정상: Q 유지<br>보류: Q→B</span></div><i>→</i><div><b>3 적치</b><span>보관 위치 확정<br>Q→S, 가용 증가</span></div><i>⋯</i><div class="exc"><b>예외</b><span>과납은 보류 기록 후 독립 승인<br>미도착 잔량 마감은 승인</span></div></div>
<div class="shots-main">${await fig('03-inbound-inspect','검수: 160 EA 중 140 EA 수령. 미수령 잔량과 검수 대기를 구분합니다.')}<div>${await fig('02-inbound-receive','수령: 위치·품목 스캔 후 실제 수량 확정','half')}${await fig('04-inbound-putaway','적치: 정상분을 보관 위치로','half')}</div></div>`);
page(11,'업무 흐름과 주요 화면 ②','출고: 예약한 곳에서 꺼내 실제 인계 시점에 차감합니다','주문 → 예약 → 피킹 → 포장 → 인계·배송. 단계 이동과 재고 반영 시점을 구분합니다.',`
<div class="process"><div><b>주문</b><span>거래처·배송지 필수<br>재고 변화 없음</span></div><i>→</i><div><b>1 예약</b><span>가용 확보<br>R +예약</span></div><i>→</i><div><b>2 피킹</b><span>예약 위치에서 꺼냄<br>S·R → P</span></div><i>→</i><div><b>3 포장</b><span>포장 단위 구성<br>배송지 스냅샷</span></div><i>→</i><div><b>4 인계·배송</b><span>실제 출하<br>P 차감</span></div></div>
<div class="shots-main">${await fig('05-outbound-picking','피킹: 예약 40 EA 후 지금 할 일과 단계별 잔량을 안내합니다.')}<div>${await fig('07-outbound-handover','인계: 배송지와 포장 내역 확인','half')}${await fig('08-stock-buckets','재고 7지표와 위치별 잔고','half')}</div></div>`);

/* 12. 테스트 전략과 결과 */
page(12,'테스트 전략과 결과','업무 규칙은 단위로, 격리·동시성은 실제 DB로, 흐름은 실제 브라우저로','npm run verify 한 명령: 타입 검사 → 단위 → 시뮬레이터 → PostgreSQL 통합 → 운영 빌드 → 브라우저',`
<div class="split"><div><table class="tests"><tr><th>층</th><th>도구</th><th>건수</th><th>무엇을 검사하나</th></tr>
<tr><td>단위</td><td>Vitest</td><td><b>371</b></td><td>엔진 40개 명령의 상태 전이·수량 한도, 권한 판정, 화면 계산 로직</td></tr>
<tr><td>시뮬레이터</td><td>node:test</td><td><b>55</b></td><td>사건 생성·일정·독립 기대값 대조·복구 판정</td></tr>
<tr><td>통합</td><td>Vitest + 실제 PostgreSQL</td><td><b>223</b></td><td>RLS 회사 격리, 불변 트리거, 동시 요청·멱등, 요청 기록, 마이그레이션</td></tr>
<tr><td>브라우저</td><td>Playwright</td><td><b>47</b></td><td>스캔 수령→출하 전체 흐름, 응답 유실 후 복구, 권한·세션 만료, 페이지 넘김</td></tr>
<tr class="sum"><td colspan="2">합계</td><td><b>696</b></td><td>2026-10-22 main(11e2095) 기준 전부 통과</td></tr></table>
${point('실패를 일부러 만든 시험','응답을 브라우저에서만 버리고 서버는 커밋시킨 뒤 재접속해 원래 요청을 복구하는지, 요청 기록 저장을 DB 트리거로 실패시켜도 업무 응답이 유지되는지 확인합니다.')}
${point('원칙','GitHub Actions에 의존하지 않고 로컬에서 같은 명령으로 검증합니다. 테스트를 건너뛰거나 끄지 않습니다.')}</div>
<div>${point('측정으로 확인한 개선','DB 앞에 왕복 20ms 지연을 넣어 같은 조건에서 비교: 기존 홈 화면 표시 1.47초→0.84초, 현장 운영 진입 2.64초→1.49초, 요청당 DB 왕복 22~34회→13~21회.')}${await fig('13-stockout-forecast','운영 관제의 품절 예측·배치도. 화면 수치와 성능 합격은 별개입니다.','short')}<div class="warning"><b>해석 주의</b><p>696은 자동화 실행 사례 수이며 작성 분량이 아닙니다. 혼잡 시험의 목표 지연·완주 기준은 아직 통과하지 못했습니다.</p></div></div></div>`);

/* 13. AI 활용 개발 방식 */
page(13,'AI 활용 개발 방식','AI가 구현하고, 사람이 규칙을 정하고 직접 써 보며 결함을 찾았습니다','개발 세션과 검증 세션을 나누고, 사용자가 결정하고 승인한 것만 main에 들어갑니다.',`
<div class="ai-flow"><div><b>요구·규칙 결정</b><span>사용자</span></div><i>→</i><div><b>구현 세션</b><span>작업 브랜치에서 코드·시험 작성</span></div><i>→</i><div><b>검증 세션</b><span>npm run verify · 전 화면 캡처 점검</span></div><i>→</i><div><b>사용자 확인</b><span>직접 사용·결함 지적</span></div><i>→</i><div><b>“반영해”</b><span>PR squash 병합 · main 일치 확인</span></div></div>
<div class="split equal tight"><div>${point('세션 분리','구현과 검증을 다른 세션·다른 도구(Codex, Claude Code)에 맡겨 같은 가정이 그대로 통과하지 않게 했습니다. 저장소 규칙(AGENTS.md·CLAUDE.md)에 로컬 검증 원칙과 출력 언어를 고정했습니다.')}${point('사용자가 정한 것','과납을 금지하지 않고 보류로 기록, 출고에 거래처·배송지 필수, 검색해서 추가하는 창고 선택, 서버 지역 등 업무·운영 판단은 사용자가 결정했습니다.')}${point('커밋 승인','AI는 작업 브랜치에만 푸시하고, 사용자가 “반영해”라고 해야 PR을 만들어 병합합니다. 병합 후 main이 검증한 커밋과 같은지 비교합니다.')}</div>
<div><h2 class="h2">직접 써 보며 찾은 결함</h2><table class="cases"><tr><th>발견</th><th>원인과 조치</th></tr>
<tr><td>출고 확인창에 “도착: 없음”</td><td>창고 위치만 보여 줌 → 거래처·배송지 필수화, 포장 시점 주소를 스냅샷으로 보존</td></tr>
<tr><td>100개 예정에 105개 도착</td><td>전면 금지면 실물이 장부에서 사라짐 → 초과분 보류 기록 + 독립 승인</td></tr>
<tr><td>메뉴 이동 중 “권한 없음”</td><td>세션 만료를 권한 부족으로 처리 → 로그인 화면으로 보내고 브라우저 시험 추가</td></tr>
<tr><td>창고 100개를 체크박스로 나열</td><td>규모를 고려 안 함 → 검색해 추가하는 선택칸, 계정 20개·기준정보 50개씩 쪽 넘김</td></tr>
<tr><td>“로딩이 너무 느리다”</td><td>측정 결과 서버 미국 동부 기본값·요청당 DB 왕복 34회·렌더 차단 글꼴 → 지역 고정, 왕복 축소, 글꼴 자체 호스팅</td></tr></table></div></div>
<div class="roles3"><div><h3>AI에게 맡긴 일</h3><p>코드·시험 작성, 문서 초안, 화면 캡처와 측정 스크립트 작성, 원인 후보 조사</p></div><div><h3>사람이 한 일</h3><p>업무 규칙과 예외 처리 결정, 직접 사용하며 결함 지적, 범위 결정, 병합 승인</p></div><div><h3>판단 근거로 삼은 것</h3><p>“통과했다”는 말이 아니라 로컬 전체 검증 결과, 변경 전후 측정값, 실제 화면 캡처</p></div></div>`);

/* 14. 한계와 자료 */
page(14,'한계와 자료','하지 않은 것을 구분하고, 근거 자료를 함께 제공합니다','',`
<div class="split equal"><div><h2 class="h2">하지 않은 것</h2><table class="limits"><tr><th>항목</th><th>현재 상태</th></tr>
<tr><td>성능 합격</td><td>혼잡 시험 목표 미달 기록만 보존. 운영 환경(Vercel·Neon) 실측과 현장 규모 부하 검증은 하지 않았습니다.</td></tr>
<tr><td>장비 연동</td><td>실제 PDA·바코드 스캐너 SDK·라벨 프린터·택배 송장 API와 연결하지 않았습니다. 스캐너는 키보드 입력 방식으로만 지원합니다.</td></tr>
<tr><td>재고 관리 범위</td><td>LOT·유통기한·FEFO, 웨이브·배치 피킹은 범위에서 뺐습니다(상온 소모품 창고 기준).</td></tr>
<tr><td>오프라인 확정</td><td>재고 이중 반영 위험으로 온라인 우선 + 결과 확인 후 재시도 방식만 지원합니다.</td></tr>
<tr><td>실제 운영</td><td>합성 데이터와 시험 회사로만 검증했고, 실제 현장 운영 기록은 없습니다.</td></tr></table>
<h2 class="h2 gap">다음에 할 일</h2><ol class="next"><li>혼잡 시험의 병목(전체 상태 읽기·잠금 대기)을 분리 계측하고 같은 부하로 재검증</li><li>품목 선택칸을 서버 검색 방식으로 바꿔 품목 수가 늘어도 첫 화면이 느려지지 않게</li><li>PDA·라벨 프린터 SDK 연동과 택배 송장 API는 실제 장비·계약 조건을 받은 뒤 설계</li></ol></div>
<div><h2 class="h2">저장소·문서</h2><div class="links">
<a href="${docsBase}">포트폴리오 문서 ↗<small>github.com/jeonking80/portfolio/WMS</small></a>
<a href="${repo}">소스 코드 ↗<small>${repo.replace('https://','')}</small></a>
<a href="${docsBase}/docs/system-architecture.md">시스템 구조 ↗<small>구조도 · 요청 처리 순서 · 역할</small></a>
<a href="${docsBase}/docs/design-decisions.md">핵심 설계 결정 ↗<small>문제 → 선택 → 대안 → 대가</small></a>
<a href="${docsBase}/docs/data-model.md">데이터 모델 ↗<small>테이블 네 묶음 · 불변식 · RLS</small></a>
<a href="${docsBase}/docs/api.md">API ↗<small>주요 API · 업무 명령 · 오류 코드</small></a>
<a href="${docsBase}/docs/testing.md">테스트 ↗<small>층별 테스트 · 측정 결과 · 한계</small></a>
<a href="https://wms-saa-s-platform.vercel.app/dashboard/v2">공개 데모 ↗<small>wms-saa-s-platform.vercel.app</small></a></div>
<p class="caption">화면 캡처: 로컬 앱·실제 PostgreSQL·합성 데이터. 시뮬레이터 이미지는 기존 로컬 시험 캡처입니다. 코드 발췌는 커밋 ${sourceCommit.slice(0,7)} 기준입니다.</p></div></div>`);

const css=`@page{size:A4 landscape;margin:0}*{box-sizing:border-box}html{background:#e4eaf2}
body{margin:0;color:#14263d;font-family:"Noto Sans KR","WenQuanYi Zen Hei","Malgun Gothic",sans-serif;font-size:11.5px;line-height:1.65;word-break:keep-all}
a{color:#1f5fbf;text-decoration:none}b{font-weight:700}
.page{width:297mm;height:210mm;padding:11mm 14mm 9mm;background:#fff;position:relative;break-after:page;overflow:hidden;margin:0 auto 8mm}
.page:last-child{break-after:auto}@media print{.page{margin:0}}
header{height:30mm}.eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.5px;color:#5a6f88}.eyebrow b{color:#fff;background:#0e2240;border-radius:4px;padding:1px 6px;margin-right:6px}
h1{font-size:23px;letter-spacing:-.6px;line-height:1.3;margin:7px 0 3px;color:#0e2240}.subtitle{font-size:10.5px;color:#4a5a6e;margin:0}
.h2{font-size:12.5px;color:#0e2240;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid #0e2240;display:inline-block}
h3{font-size:11.5px;margin:0 0 3px;color:#16365f}p{margin:0 0 7px}
.page-body{height:155mm}footer{position:absolute;left:14mm;right:14mm;bottom:6mm;display:flex;justify-content:space-between;font-size:8.5px;color:#8a9bb0;border-top:1px solid #e3e9f0;padding-top:4px}
.split{display:grid;grid-template-columns:1.05fr 1fr;gap:9mm;height:100%;align-items:start}.split.equal{grid-template-columns:1fr 1fr}.split.tight{height:auto;margin-top:5mm}
.point{padding:0 0 7px;margin-bottom:7px;border-bottom:1px solid #e3e9f0}.point:last-child{border-bottom:0}.point p{margin:0;font-size:11px;line-height:1.72;color:#2c3e55}
.note{background:#eef3fb;border-left:3px solid #1f5fbf;padding:8px 10px;color:#22446c;font-size:9.5px;line-height:1.7;margin-top:6px}
.warning{background:#fff6e6;border-left:3px solid #c27c0e;padding:8px 10px;font-size:9.5px;margin-top:6px}.warning p{margin:2px 0 0}
.caption,figcaption{font-size:8.5px;color:#5a6f88;margin-top:4px}
figure{margin:0}.shot{border:1px solid #d5dee8;border-radius:6px;overflow:hidden;background:#f4f6f9}.shot img{display:block;width:100%;height:auto}
figure{margin:0 0 7px}figure.short .shot{max-height:62mm}figure.short .shot img{object-fit:cover;object-position:top;height:62mm}
figure.tablet .shot{max-height:52mm}figure.tablet .shot img{height:52mm;object-fit:cover;object-position:top}
table{width:100%;border-collapse:collapse;font-size:10.6px}th{background:#0e2240;color:#fff;text-align:left;padding:5px 7px;font-weight:600}td{padding:5px 7px;border-bottom:1px solid #e3e9f0;vertical-align:top}
tr.sum td{background:#eef3fb;font-weight:600}
.tag{display:inline-block;border:1px solid #c5ced9;border-radius:999px;padding:2px 9px;margin:0 5px 5px 0;font-size:9.5px;color:#22446c;background:#fff}
.cover{display:grid;grid-template-columns:1fr 1.25fr;gap:10mm;align-items:center;padding:16mm}.cover-name{font-size:52px;font-weight:800;letter-spacing:-2px;color:#0e2240;margin:8px 0 4px}
.lead{font-size:13.5px;line-height:1.75;color:#2c3e55;margin:0 0 12px}.cover-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:10.5px;margin-top:14px}.cover-meta dt{color:#5a6f88}.cover-meta dd{margin:0;font-weight:600}
.overview{display:grid;grid-template-columns:1.15fr 1fr;gap:10mm}.rules{margin:0;padding:0;list-style:none;counter-reset:r}.rules li{counter-increment:r;position:relative;padding:0 0 9px 30px;margin-bottom:9px;border-bottom:1px solid #e3e9f0}
.rules li:before{content:counter(r);position:absolute;left:0;top:0;width:21px;height:21px;border-radius:50%;background:#1f5fbf;color:#fff;font-weight:700;text-align:center;line-height:21px}.rules b{display:block;font-size:11.5px}.rules span{font-size:11px;color:#2c3e55}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.metrics div{border:1px solid #dde3ea;border-radius:8px;padding:9px 10px}.metrics strong{display:block;font-size:24px;line-height:1.1;color:#0e2240}.metrics span{font-size:9.5px;color:#2c3e55}.metrics small{color:#6b7c90}
.arch{display:grid;grid-template-columns:1fr 34px 2.1fr 34px 1.15fr;gap:5px;align-items:stretch;height:108mm}.arch-col{display:flex;flex-direction:column;gap:5px}.arch-label{font-size:9px;font-weight:700;color:#5a6f88;margin-bottom:1px}.arch-label.second{margin-top:6px}
.box{border:1px solid #c5ced9;border-radius:6px;padding:6px 8px;background:#fff;font-size:9.8px;font-weight:600;flex:1;display:flex;flex-direction:column;justify-content:center}.box small{font-weight:400;color:#5a6f88;font-size:8.8px}
.box.layer{background:#f4f6f9;flex:0 0 auto}.box.core{background:#0e2240;color:#fff;border-color:#0e2240}.box.core small{color:#c9d4e3}.box.db{background:#eaf1fb;border-color:#9fbbe0}.box.ext{border-style:dashed}
.arch-split{display:grid;grid-template-columns:1fr 1fr;gap:5px;flex:1}.arch-arrow{display:flex;align-items:center;justify-content:center;text-align:center;font-size:8.5px;color:#1f5fbf;font-weight:700}
.arch-notes{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm;margin-top:6mm}
.stack-table td:first-child{font-weight:700;color:#0e2240;white-space:nowrap}.stack-table td:nth-child(2){font-weight:600;white-space:nowrap}.stack-table td:last-child{color:#5a6f88}
.model{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.group{border-radius:8px;padding:8px;border:1px solid #dde3ea}.group h3{font-size:11px;margin-bottom:6px}.group h3 small{display:block;font-weight:400;color:#5a6f88;font-size:8.6px}
.g1{background:#f6f8fb}.g2{background:#eef6f1}.g3{background:#fff4f1}.g4{background:#f6f3fb}
.tbl{background:#fff;border:1px solid #dde3ea;border-radius:5px;padding:4px 6px;margin-bottom:4px}.tbl b{display:block;font-family:ui-monospace,Consolas,monospace;font-size:8.8px;color:#0e2240}.tbl span{font-size:8.6px;color:#4a5a6e}.tbl.key{border-color:#1f5fbf;box-shadow:inset 3px 0 0 #1f5fbf}
.relations{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}.relations div{border:1px dashed #9fbbe0;border-radius:6px;padding:6px 8px;font-size:9.4px}.relations b{font-family:ui-monospace,Consolas,monospace;font-size:8.8px}.relations em{font-style:normal;color:#1f5fbf;font-weight:800;margin:0 3px}.relations span{display:block;color:#5a6f88;font-size:8.6px}
.flow{display:flex;flex-direction:column;gap:3.2px}.flow-step{display:grid;grid-template-columns:22px 1fr 210px;gap:9px;align-items:center;border:1px solid #dde3ea;border-radius:6px;padding:4px 9px}.flow-step .n{width:20px;height:20px;border-radius:50%;background:#0e2240;color:#fff;font-weight:700;text-align:center;line-height:20px;font-size:9.5px}
.flow-step b{font-size:10.2px}.flow-step p{margin:0;font-size:9.2px;color:#4a5a6e}.flow-step em{font-style:normal;font-size:9px;color:#b42318;background:#fdf0ee;border-radius:4px;padding:3px 6px}
.code-layout{display:grid;grid-template-columns:1.25fr 1fr;gap:8mm;height:100%}.code-label{font-size:8.6px;color:#5a6f88;margin:0 0 2px}
.source-code{margin:0 0 6px;padding:7px 9px;background:#0e1b2c;color:#e3ebf5;border-radius:6px;font-family:ui-monospace,Consolas,"DejaVu Sans Mono",monospace;font-size:8.2px;line-height:1.48;white-space:pre;overflow:hidden}
.layers{display:flex;flex-direction:column;gap:5px}.sec{border-left:4px solid #1f5fbf;background:#f6f8fb;border-radius:0 6px 6px 0;padding:6px 10px}.sec b{font-size:10.8px;color:#0e2240}.sec p{margin:1px 0 0;font-size:10.4px;color:#2c3e55}
.sec:nth-child(2){border-color:#0e7a4d}.sec:nth-child(3){border-color:#6b4fbf}.sec:nth-child(4){border-color:#c27c0e}.sec:nth-child(5){border-color:#b42318}
.guard td:first-child{font-weight:600}.guard td:nth-child(2){font-family:ui-monospace,Consolas,monospace;font-size:8.8px;color:#16365f}
.process{display:flex;align-items:stretch;gap:5px;margin-bottom:6mm}.process div{flex:1;border:1px solid #c5ced9;border-radius:7px;padding:7px 9px;background:#f6f8fb}.process div b{display:block;font-size:11px;color:#0e2240}.process div span{font-size:9.2px;color:#4a5a6e}.process i{align-self:center;font-style:normal;color:#1f5fbf;font-weight:800}.process .exc{background:#fff6e6;border-color:#e9c48a}
.shots3{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}
.shots-main{display:grid;grid-template-columns:1.55fr 1fr;gap:6mm}figure.half .shot img{height:44mm;object-fit:cover;object-position:top}
.band{display:grid;grid-template-columns:1.2fr 1fr;gap:10mm;margin-top:7mm;padding-top:6mm;border-top:1px solid #e3e9f0}.band p{font-size:11px}
.principles,.roles3{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm;margin-top:6mm}.roles3 div{background:#f6f8fb;border-radius:8px;padding:9px 11px}.roles3 p{margin:0;font-size:10.6px;color:#2c3e55}
.h2.gap{margin-top:7mm}.next{margin:0;padding-left:18px;font-size:11px}.next li{margin-bottom:5px}
.tests td:nth-child(3){text-align:right;font-size:12px}
.ai-flow{display:flex;gap:5px;align-items:stretch}.ai-flow div{flex:1;background:#0e2240;color:#fff;border-radius:7px;padding:7px 9px}.ai-flow div b{display:block;font-size:10.6px}.ai-flow div span{font-size:8.8px;color:#c9d4e3}.ai-flow div:last-child{background:#1f5fbf}.ai-flow i{align-self:center;font-style:normal;color:#1f5fbf;font-weight:800}
.cases td:first-child{font-weight:600;white-space:nowrap;color:#b42318}.cases td{font-size:10.2px}
.limits td:first-child{font-weight:700;white-space:nowrap;color:#0e2240}
.links{display:grid;grid-template-columns:1fr 1fr;gap:6px}.links a{border:1px solid #dde3ea;border-radius:7px;padding:7px 10px;font-weight:700;font-size:10.2px}.links small{display:block;font-weight:400;color:#5a6f88;font-size:8.6px}`;

const ordered=pages.map((html,index)=>html.replace('__PAGE__',String(index+1).padStart(2,'0')));
const document=fontCss=>`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WMS Lite 포트폴리오</title>${fontCss}<style>${css}</style></head><body>${ordered.join('\n')}</body></html>`;
// The shared HTML loads the font from Google; the PDF embeds the self-hosted subsets from the last `next build`.
await writeFile(resolve(output,'wms-lite-portfolio.html'),document('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700;800&display=swap">'));
let printFonts='';
const chunks=resolve(root,'.next/static/chunks');
if(existsSync(chunks))for(const name of await readdir(chunks))if(name.endsWith('.css')){
  const text=await readFile(resolve(chunks,name),'utf8');
  if(text.includes('@font-face{font-family:Noto Sans KR')){
    printFonts='<style>'+(text.match(/@font-face\{font-family:Noto Sans KR;[^}]*\}/g)||[]).join('').replaceAll('url(../media/',`url(${pathToFileURL(resolve(root,'.next/static/media')).href}/`)+'</style>';
    break;
  }
}
if(!printFonts)console.warn('Noto Sans KR build fonts not found; run `npm run build` first for the intended typeface.');
const printPath=resolve(output,'.print.html');await writeFile(printPath,document(printFonts));
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
try{
  const tab=await browser.newPage({viewport:{width:1400,height:1000}});
  await tab.goto(pathToFileURL(printPath).href,{waitUntil:'load'});await tab.evaluate(()=>document.fonts.ready);await tab.emulateMedia({media:'print'});
  const layout=await tab.evaluate(()=>[...document.querySelectorAll('.page')].map((p,i)=>{const limit=p.querySelector('footer').getBoundingClientRect().top-3;return{page:i+1,title:(p.querySelector('h1')?.textContent||p.querySelector('.cover-name')?.textContent||'').trim(),overflow:[...p.querySelectorAll('.page-body *, .cover-text *')].filter(el=>el.getBoundingClientRect().bottom>limit&&el.getBoundingClientRect().height>0).map(el=>el.tagName+'.'+el.className).slice(0,4),images:[...p.querySelectorAll('img')].every(im=>im.complete&&im.naturalWidth>0)}}));
  const codeFits=await tab.locator('.source-code').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth+1&&el.scrollHeight<=el.clientHeight+1));
  const font=await tab.evaluate(()=>document.fonts.check('12px "Noto Sans KR"','검수'));
  if(!codeFits||layout.some(p=>p.overflow.length||!p.images)){console.log(JSON.stringify({codeFits,layout},null,2));throw Error('Portfolio layout validation failed')}
  await tab.pdf({path:resolve(output,'wms-lite-portfolio.pdf'),format:'A4',landscape:true,printBackground:true,preferCSSPageSize:true});
  if(process.env.PORTFOLIO_PREVIEW_DIR){await mkdir(process.env.PORTFOLIO_PREVIEW_DIR,{recursive:true});const boxes=await tab.locator('.page').all();for(const [i,box] of boxes.entries())await box.screenshot({path:resolve(process.env.PORTFOLIO_PREVIEW_DIR,`page-${String(i+1).padStart(2,'0')}.png`)});}
  await writeFile(resolve(root,'docs/assets/portfolio/pdf-validation.json'),JSON.stringify({page_count:pages.length,noto_sans_kr_embedded:font,layout:layout.map(({page,title,images})=>({page,title,images,overflow:false})),source_commit:sourceCommit,rendered_at:new Date().toISOString()},null,2)+'\n');
  console.log(JSON.stringify({pages:pages.length,font,pdf:'public/portfolio/wms-lite-portfolio.pdf',html:'public/portfolio/wms-lite-portfolio.html',layout:'passed'}));
}finally{await browser.close();await import('node:fs/promises').then(fs=>fs.rm(printPath,{force:true}))}
