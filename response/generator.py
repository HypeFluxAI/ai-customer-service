"""AI 回复生成 — 基于知识库上下文和对话历史生成客服回复"""

import logging

import anthropic

from analysis.vision import ChatMessage

logger = logging.getLogger("ai_cs.response.generator")

SYSTEM_PROMPT = """당신은 DeepLink 고객 지원 AI 어시스턴트입니다.

## 역할
- DeepLink GPU 클라우드 컴퓨팅 서비스에 대한 고객 문의에 답변합니다
- 친절하고 전문적인 태도로 한국어로 응답합니다
- 정확한 정보만 제공하고, 모르는 것은 솔직히 모른다고 합니다

## 응답 규칙
1. 간결하게 답변하세요 (최대 3-4문장)
2. 기술적인 내용은 쉽게 설명하세요
3. 민감한 정보(지갑 주소, 비밀번호 등)를 절대 공유하지 마세요
4. 환불, 결제 분쟁 등은 "담당자에게 전달하겠습니다"로 안내하세요
5. 확실하지 않은 정보는 추측하지 마세요

## 참고 지식
{kb_context}

## 최근 대화 기록
{conversation_history}

위의 지식과 대화 맥락을 참고하여 사용자의 최신 메시지에 답변하세요."""


def generate_reply(client: anthropic.Anthropic,
                   user_message: str,
                   kb_results: list[dict],
                   history: list[ChatMessage],
                   model: str = "claude-sonnet-4-20250514") -> str:
    """생성 AI 응답"""
    # 지식 컨텍스트 구성
    if kb_results:
        kb_texts = []
        for r in kb_results[:5]:
            src = r.get("metadata", {}).get("source_file", "")
            kb_texts.append(f"[{src}] {r['text'][:300]}")
        kb_context = "\n---\n".join(kb_texts)
    else:
        kb_context = "(관련 지식 없음)"

    # 대화 기록 구성
    if history:
        history_lines = []
        for m in history[-10:]:
            role = "고객" if m.is_user else "상담원"
            history_lines.append(f"{role}: {m.text}")
        conversation_history = "\n".join(history_lines)
    else:
        conversation_history = "(새 대화)"

    system = SYSTEM_PROMPT.format(
        kb_context=kb_context,
        conversation_history=conversation_history,
    )

    try:
        response = client.messages.create(
            model=model,
            max_tokens=300,
            temperature=0.3,
            system=system,
            messages=[{
                "role": "user",
                "content": user_message,
            }]
        )
        reply = response.content[0].text.strip()
        logger.info(f"Generated reply: {reply[:80]}...")
        return reply

    except Exception as e:
        logger.error(f"Response generation failed: {e}")
        return ""
