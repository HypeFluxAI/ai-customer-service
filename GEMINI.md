# DeepLink AI 고객 서비스 시스템

이 프로젝트는 DeepLink GPU 클라우드 서비스의 AI 고객 지원 자동화 시스템입니다.

## 훈련 모드

이 프로젝트에서 Gemini CLI를 실행하면 고객 서비스 AI를 훈련할 수 있습니다.
두 가지 MCP 서버가 자동으로 연결됩니다:
- **deeplink-kb**: ChromaDB 벡터 검색 지식베이스
- **deeplink-mongo**: MongoDB 전체 데이터베이스 (채팅 로그, KB, QnA, AI 품질)

## 훈련원이 할 수 있는 일

### 기본 훈련
- 고객처럼 질문하면 AI가 KB를 검색하여 답변합니다
- "이 질문에는 이렇게 대답해야 해" → 즉시 학습
- "틀렸어, 정확한 답은..." → 수정 학습

### 고급 분석 (@cs-trainer)
- "최근 일주일 채팅 통계 보여줘" → 세션수, 메시지수, 피크 시간 분석
- "KB 갭 분석해줘" → 자주 묻지만 KB에 없는 질문 발굴
- "AI 품질 리포트" → 건의 채택률, 유사도, 품질 점수 분석
- "최근 대화 리뷰해줘" → 잘 답변한 것 / 못 한 것 분류 + KB 보강 제안

### 지식베이스 관리
- KB 항목 조회/추가/수정/삭제
- Q&A 관리 (한국어/중국어/영어 3개국어)
- 문서 파일 일괄 가져오기

## 사용 가능한 도구

### ChromaDB (deeplink-kb)
`kb_search`, `kb_teach`, `kb_correct`, `kb_add_document`, `kb_import_file`, `kb_stats`, `kb_delete_source`

### MongoDB (deeplink-mongo)
`chat_logs_query`, `chat_stats`, `kb_list`, `kb_add`, `kb_update`, `kb_delete`, `qna_list`, `qna_add`, `ai_quality_report`, `frequent_questions`, `training_log`

## 프로젝트 구조
- `server/` — Node.js 백엔드 (Express + WebSocket)
- `mcp/` — MCP 서버 (Python, Gemini CLI 연동)
- `knowledge/` — ChromaDB 벡터 스토어
- `desktop/` — Windows 데스크톱 자동화 (KakaoTalk)
- `.gemini/` — Gemini CLI 설정, 스킬, 에이전트
