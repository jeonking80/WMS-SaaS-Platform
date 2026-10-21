# Native PostgreSQL에서 같은 빌드의 Node 1개/2개 비교

2026-10-21에 수행한 **한 번의 순서형 제한 진단**이다. Node 2개에서 같은 600건 코호트의 적용 확인 시간이 100.223초에서 71.943초로 28.2% 짧았다. 정식 혼잡·G3·8시간 합격 판정은 하지 않는다. 원래 네 차례 정식 실패는 그대로 보존했다.

| 구성 | 적용 확인 시간 | 확인/최종 커밋 | 기술 실패 시도 | 독립 보존 차이 |
| --- | ---: | ---: | ---: | ---: |
| cluster primary + worker 1개, pool 5 | 100.223초 | 600/600 | 0 | 0 |
| 같은 primary + worker 2개, pool 3+2 | 71.943초 | 600/600 | 0 | 0 |

두 구성 모두 source `42331d65f7d03f966736ffadcaee6cc03bf54efa`, build `ygoExTu2jqOW7riRXrCxw`, 불변 runtime revision `r2`, schema20을 사용했다. 진행 중인 schema21 소스 변경은 포함하지 않았다. 진단 ON, 기존 수락 이벤트 회사별 300건, 새 유입/실물 작업자 0명이며 HTTP timeout15초, pulse50ms, 회사별 poll10개/backoff250ms, processor1개/limit50, cap300초를 유지했다. 원래 driver 변경은 loopback 안전 포트3027→3028뿐이다.

PostgreSQL17.9 바이너리/라이브러리를 기존 로컬 이미지에서 추출하여 일반 사용자 native process로 실행했다. 각 arm의 실제 primary·worker·client가 자기 PID/startticks/namespace/root inode/4CPU·32GiB 제한을 시작 전에 기록했다. PostgreSQL은 exec 전 동일 PID/startticks 증거와 실행 후 cgroup/자식 관계로 연결했다. 보호된 PostgreSQL `/proc` namespace를 직접 읽었다고 주장하지 않는다. 실제 PID 검증이 끝난 다음에만 client main을 열었다. 전역 cgroup 설정은 바꾸지 않았다.

각 arm 종료 후 10초간 버전 안정 및 비활성 애플리케이션 세션을 확인했다. 회사별 전체 ledger31페이지와 같은 경계 snapshot을 보존하고 Python으로 모든 재고/ledger bucket·예약·주문/입고 line 보존을 검증했다. single 경계는6997/6995, dual은6995/6997이다. 코호트 밖 처리 분포가 회사별 두 건씩 달라 전체 최종 상태 수를 JSON에 남겼다. 최종 적용 합계는 양쪽 모두3885건이지만 회사별은 single1945/1940, dual1943/1942이므로 전체 회사별 작업량이 같았다고 주장하지 않는다. 두 runtime과 native PostgreSQL을 종료했고3028/55440 listener가 없음을 확인했다. native postmaster는 PID1이 회수하지 않은 비활성 zombie로 남았으며 실행 중인 서버는 아니다.

한 번의 single→dual 순서에는 cache/실행 순서 잡음이 있다. native PostgreSQL의 자원 배치·설정·저장소가 이전 Docker 진단과 다르므로 과거106초와 절대 비교하지 않는다. 실제 source 유입과 실물 작업을 포함한 공식 프로필 효과도 입증하지 않는다.

[정제된 결과 및 해시](v2-cluster-native-comparison.json)에 원시 증거 위치를 남겼다. upstream runtime manifest와 comparator adoption manifest는 범위가 달라 해시가 다르다. driver 해시는 각 arm 시작 시 고정했다. passive resource preload/barrier/verifier 해시는 실행 후에 기록했으며, 당시 동일함은 독립 검토자가 관찰했다. 이 세 harness의 arm별 암호학적 시작 증명이 있었다고 주장하지 않는다. 다음 정식 준비에서는 이 파일들까지 실행 전에 동결하고 자기 증거에 해시를 포함한다. 불변 archive, 두 새 native DB 및 이전 실패 증거는 보존했다.
