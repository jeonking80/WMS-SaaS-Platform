# 보류 해제 입력·이력 일치 검증

`hold.release` 엔진은 최상위 lot·수량·위치를 처리하지만, 기존 스캔 검증과 작업 이력은 요청에 `lines` 배열이 있으면 그 배열을 우선했다. 빈 배열은 실제 대상의 검증을 생략했고, 다른 lot의 명세는 실제 처리와 다른 스캔·이력을 만들 수 있었다.

명령별로 보류 해제는 항상 최상위 입력 하나를 검증·기록하도록 네 줄을 수정했다. 추가 명세는 엔진과 동일하게 무시한다. 다른 명령의 배열 처리, 권한·수량·과납 승인 조건·트랜잭션은 그대로 유지한다.

기존 코드에서 새 검사 2개가 실패했다. 잘못된 입력은 거절되지 않았고, 정상 최상위 스캔에서 환산한 수량도 사용되지 않았다. 수정 후 전체 PostgreSQL 수락 검사 37개와 typecheck가 통과했다. 거절 시 재고·원장·요청·작업 이력 모두 불변이고, 성공 시 실제 lot만 변경되며 해당 바코드 환산 이력이 남고 재전송은 한 번의 효과만 유지되는지 확인했다.

| 로그 | SHA-256 |
| --- | --- |
| `/tmp/v2-hold-release-singleton-old-source-pg.log` | `93bdae37df038f37b132f3e9bd1c1ace3f59b48749c1258ba3e5462fcd556d6b` |
| `/tmp/v2-hold-release-singleton-fixed-pg.log` | `bfc1078e43d4e3bf8f54d1455ade2b67470c848821e7e264b0ab6bfd5d9fb796` |
| `/tmp/v2-hold-release-singleton-typecheck.log` | `e5568bab5df410bc361d2f0f3271359f22d9cee51ec1f6648bfb6454f1fbda31` |

전체 검증 종료 코드 0: 단위359·시뮬레이터55·PostgreSQL223·브라우저44개와 타입·standalone 빌드가 통과했다. 빌드 `Lb3NKb1lCgfxlUs60Wy1T`, 로그 `/tmp/wms-v2-hold-singleton-full-verify.log`, SHA-256 `e65bbe6963d0a1f0023c67833ced1a36d60cd61f3dc8cf88ec354b5f8db79134`. DB 변경은 없으며 schema22의 기존 복원 근거는 원래 실행 범위로 보존한다. 여섯 번째 혼잡 시험은 준비 후 정지했으며 정식 클라이언트·초기 수령·측정 프로필은 시작하지 않았다. 이전 다섯 실패는 유지하고 새 빌드는 별도 새 DB로 시험한다. 전체 기획이나 G3~G5 완료를 뜻하지 않는다.
