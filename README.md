# claude-news-radar

클로드 새 소식을 남보다 먼저 알기 위한 감지기입니다. GitHub Actions가 15분마다 공식 소스를 읽고, 처음 보는 소식이 있으면 휴대폰의 [ntfy](https://ntfy.sh) 앱으로 푸시를 보냅니다. 외부 패키지는 쓰지 않습니다.

## 보는 곳
| 소스 | 주소 | 알림 |
|---|---|---|
| Claude 블로그 (제품 소개 글) | claude.com/resources/articles | 높음 |
| Anthropic 소식 | anthropic.com/news | 높음 |
| Claude 앱 릴리스 노트 | docs.claude.com/en/release-notes/claude-apps | 높음 |
| API 릴리스 노트 | docs.claude.com/en/release-notes/overview | 보통 |
| Claude Code 새 버전 | github.com/anthropics/claude-code/releases ('Added' 줄이 있는 버전만) | 보통 |
| Claude 요금제 | claude.com/pricing (요금제 카드 글자가 바뀌면) | 높음 |
| 해커뉴스 화제 | 제목에 Claude·Anthropic, 150점 이상, 3일 안 | 보통 |

## 동작
- `state/seen.json`에 본 소식 ID를 저장하고, 실행이 끝나면 워크플로가 커밋합니다.
- 첫 실행은 지금 있는 소식을 기준으로 삼고 "감지 시작" 알림 한 통만 보냅니다.
- 한 번에 새 소식이 8개를 넘으면 나머지는 요약 한 통으로 보냅니다.
- 어떤 소스를 2시간째(8회 연속) 읽지 못하면 경고 알림을 한 번 보냅니다. 페이지 구조가 바뀐 경우입니다.

## 설정
- 저장소 비밀값 `NTFY_TOPIC`: ntfy 주제 이름입니다. 이 이름을 아는 사람은 알림을 볼 수 있으니 비밀로 둡니다.
- 휴대폰: ntfy 앱 → 구독(+) → 서버는 ntfy.sh 그대로 두고 주제 이름 입력.

## 손으로 돌리기
```bash
DRY=1 node radar.mjs   # 알림을 보내지 않고, 상태도 저장하지 않음
```
- Actions 탭 → radar → Run workflow로도 바로 실행할 수 있습니다.
- GitHub 예약 실행은 붐빌 때 몇 분~수십 분 늦을 수 있습니다.
- 공개 저장소는 60일 동안 활동이 없으면 예약이 꺼집니다. 새 소식 커밋이 자주 생겨서 보통은 괜찮습니다.
