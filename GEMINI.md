# DeepLink AI 고객 서비스 시스템

이 프로젝트는 DeepLink GPU 클라우드 서비스의 AI 고객 지원 자동화 시스템입니다.

## 훈련 모드 사용법

이 프로젝트 디렉토리에서 `gemini` 를 실행하면 고객 서비스 훈련을 시작할 수 있습니다.

### 고객으로 대화하기
직접 한국어로 질문하면 고객 서비스 AI가 지식베이스를 검색하여 답변합니다.

### 지식 교육하기
"이 질문에는 이렇게 대답해야 해" 형태로 알려주면 즉시 학습합니다.

### 잘못된 답변 수정하기
"틀렸어, 정확한 답은..." 형태로 알려주면 수정합니다.

### 사용 가능한 도구
- `kb_search`: 지식베이스 검색
- `kb_teach`: Q&A 교육
- `kb_correct`: 답변 수정
- `kb_add_document`: 문서 추가
- `kb_import_file`: 파일 가져오기
- `kb_stats`: 통계 확인
- `kb_delete_source`: 출처별 삭제

### 전용 에이전트
`@cs-trainer` 를 사용하면 고객 서비스 훈련 전문 에이전트가 활성화됩니다.

## 프로젝트 구조
- `core/` — 메인 엔진
- `knowledge/` — ChromaDB 지식베이스
- `response/` — AI 응답 생성
- `mcp/` — MCP 서버 (Gemini CLI 연동)
- `.gemini/` — Gemini CLI 설정, 스킬, 에이전트
