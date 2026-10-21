# V2 전체 상태 읽기·복제 후속 검토안

작성: 2026-10-21 UTC. **읽기 전용 코드 검토에 따른 후보이며 아래 최적화는 미구현·미계측이다.** 공식 25분 프로필의 코드·조건·판정은 이 검토안으로 변경하지 않는다. 공식 실행 결과를 확인한 뒤 후속 작업 여부를 결정한다.

공유된 schema-20 opt-in bounded 관측은 112개 사건에서 persistence SQL 약 750ms, 전체 상태 읽기 약 5,686ms, 상태 clone 약 3,022ms, 50개 사건 batch 약 7.9초였다. 이전 persistence SQL 관측은 약 13,191ms였다. 이 작은 표본은 공식 부하 합격이나 개별 변경의 인과 효과를 증명하지 않는다. 단계는 포함 시간이며 중첩 여부를 확인하지 않고 합산하지 않는다. SQL await에는 서버 실행·전송·기본 pg JSON 파싱·이벤트 루프 대기가 함께 들어 있다.

## 1순위: 잠금 뒤 전체 body 전송 형식 비교

현재 `readWorkflowState`는 header를 `FOR UPDATE` 또는 `FOR SHARE`로 잠근 다음, 별도 SQL에서 모든 `kind,body` 행을 읽어 배열을 복원한다. 약 16,000행을 각각 pg 행 객체로 만들고 JSON body를 개별 파싱하는 비용이 남을 수 있다.

첫 후보는 **두 번째 SQL만** 전체 배열 JSONB 집계로 바꾸는 것이다. kind별 `jsonb_agg(body ORDER BY position)`를 `jsonb_object_agg(kind,bodies)`로 묶고, JS에서 header metadata에 합친다. 빈 결과는 `{}`로 처리하여 metadata의 빈 배열을 유지한다. 모든 body와 배열을 계속 읽으며 ID 중복, 순서, JSON null·scalar·중첩 배열, 미지의 미래 필드도 보존한다. 기존 tenant/warehouse 조건과 invoker RLS를 유지한다.

이 방식은 네트워크 행 수, pg 객체 생성과 JSON.parse 호출 수를 줄일 후보다. 반면 PostgreSQL의 JSONB 재구성, 정렬과 메모리 사용이 늘고, 큰 단일 결과의 파싱·할당도 남는다. 기존 body datum과 버퍼 캐시가 이미 따뜻해도 집계 결과는 요청마다 재구성된다. `work_mem`만으로 대형 JSONB 집계의 메모리가 제한된다고 가정하지 않는다. 현재 scope/position 인덱스 활용과 실제 정렬·임시파일·메모리 비용을 격리 사본에서 확인해야 한다.

**header 잠금과 body 조회를 한 SQL로 합치지 않는다.** READ COMMITTED에서 잠금을 기다린 header는 EvalPlanQual로 새 값을 받지만 같은 문장의 body는 이전 snapshot을 볼 수 있다. 현재의 별도 잠금 문장 → 별도 body 문장 순서를 유지한다. 일반 비잠금 compatibility view 조회의 단일 snapshot 의미도 유지한다. helper를 VOLATILE로 바꾸어 이 문제를 우회하지 않는다.

## 2순위: 저장 전용 stock clone 한 번 제거

`persist`의 내부 저장 wrapper는 현재 `ledger_base:structuredClone(after.stock)`를 만든다. 이 wrapper는 외부로 반환하지 않고 `writeWorkflowState`에서 직렬화만 한다. 해당 구간에서 `after.stock`을 변경하거나 외부에 노출하지 않는 조건을 유지하면 `ledger_base:after.stock`으로 동일한 저장 JSON을 만들 수 있다. business/reconcile 경로와 반환 객체를 바꾸지 않는 작은 후보지만 stock 크기가 작으면 효과도 작다.

반면 `lockState`의 baseline을 단순히 live stock에 alias하면 안 된다. 이후 `structuredClone`은 alias 관계까지 보존하므로 엔진의 stock 변경이 baseline도 변경하여 원장 대사를 훼손할 수 있다. 엔진 전체 clone 3초를 이 작은 clone 제거의 예상 절감량으로 취급하지 않는다.

## 3순위: 변경 body를 증명하는 복제 방식

현재 UPDATE 읽기 직후의 baseline 직렬화와 저장 직전 각 body 직렬화는 hydration이 before-state를 직접 수정하는 경우까지 잡는 정확한 변경 검출 장치다. 전체 `structuredClone` 뒤에는 변경하지 않은 객체도 참조가 달라지므로 참조 비교만으로 이 두 순회를 제거할 수 없다.

더 큰 후속 후보는 불변 persisted baseline과 copy-on-write draft를 두고, 실제로 수정한 top-level body의 부모까지 표시하는 방식이다. engine뿐 아니라 legacy overage 복구·approval separation도 같은 계약에 들어가야 한다. 변경하지 않은 참조가 원본과 같다는 증명이 있으면 그 body의 stringify를 생략하고, 표시된 body는 기존 정확 비교를 유지할 수 있다. 전체 업무 검증과 reconcile은 계속 모든 객체를 순회한다.

객체 version만으로 변경을 판단하지 않는다. 예를 들어 `hold.release`, overage 승인과 legacy hydration은 중첩 lot를 바꾸면서 부모 receipt version을 항상 올리지 않는다. 해시만으로 같음을 판정하는 방법도 정확 비교의 대체 증명이 아니다. `JSON.parse(JSON.stringify(state))`를 `structuredClone`의 동등한 대체로 가정하지 않는다. undefined·alias 등 JS 의미의 차이가 있다.

프로세스 상태 캐시는 우선순위를 낮춘다. header 잠금 아래 version 일치 확인, 실제 commit 이후에만 캐시 게시, rollback·legacy write·다중 프로세스 갱신에 대한 무효화, tenant/warehouse 분리와 메모리 상한이 필요하다. 이 계약 없이 미커밋 after-state를 재사용하지 않는다.

## 검증과 결정 경계

- 동일한 독립 restore·build·설정에서 현재 경로와 후보 하나씩 비교한다. 변화하는 backlog에 연속 실행한 결과만으로 개선을 확정하지 않는다.
- 전체 aggregate의 body/ID/version/배열 순서·삭제·미래 scalar/null 배열을 독립 비교한다. 잠금 대기 후 읽기, 두 writer, tenant/warehouse RLS, legacy 쓰기 재시도와 rollback을 유지한다.
- stock·불변 원장·요청 hash/result·performance·receiving·외부 revision의 같은 트랜잭션 원자성, 응답 유실 후 replay와 재시작 후 효과 1회를 다시 확인한다. 반품 누계, 배송 정정, 과거 actor, lot 승인 분리도 유지한다.
- 별도 계측으로 SQL 집계 비용, 전송 크기·행 수, JSON 파싱/JS 복원, baseline 비교·engine clone·GC를 구분한다. 충분한 표본 없이 CPU 절감량을 예상 수치로 제시하지 않는다.
- 작은 후보를 통과시켜도 원래 공식 프로필의 5,400개 공급, 정상/peak 조건, peak 종료 후 10분 회복과 실제 8시간 조건을 별도로 판정한다. 이번 문서에는 공식 실행 결과를 추가하거나 실패를 통과로 바꾸지 않는다.

완료 객체를 읽기에서 제외하거나 hot/cold로 일부만 hydrate하는 변경, 검증 삭제, 풀 확대와 타임아웃 연장은 이 후보에 포함하지 않는다.
