# Countersign (PayPal AI Hackathon 2026): 에이전트 작업 규칙

대회 자료·규칙 원문: `~/Desktop/gmail/contest-kit/20261113_paypal-ai-hackathon/` (결정.md, 규칙_원문.md, 원문/).
마감: 2026-11-12 12:00 PST = **2026-11-13(금) 05:00 KST**. 마감 뒤 레포·영상·링크 수정 금지, 12/21까지 데모·sandbox·키 유지.

## 합의된 것 (2026-11-06 사용자 결정)
- 1순위(에이전트 결제 방화벽) + 2순위(분쟁·환불 코파일럿)를 한 제품으로. 3순위(공동 경비 정산)는 선택 기능(인보이스로 요청).
- 비전 + 실제 동작 증거를 첫 화면·README 첫 문단·영상에 같이 보인다(«30초 스토리» 버튼).
- 숫자·판정·기한·돈 이동은 코드. LLM은 정책 초안, 상품 고르기, 분쟁 문구만. 애매하면 되묻기, 실패는 화면에 보인다.
- 키 없이 완전히 동작(가짜 PayPal·데모 카탈로그·규칙 파서). 환경변수만 넣으면 sandbox·Claude/DeepSeek·Channel3로 전환.
- 금지: 다른 프로젝트 코드 복사·참조(권리 문제, 세부는 contest-kit의 결정.md), 회사 자산(파일·데이터·브랜드·상품) 사용. 데모 상품·상점은 가상(.example).
- 원격 저장소 없음. 공개 GitHub 생성은 사용자 확인 뒤.

## 착수 브레인스토밍 기록
- 목표: Agentic Commerce + PayPal+AI 특별상과 대상, Channel3 스폰서상.
- 성공 기준: 심사위원이 키 없이도 30초 안에 «정책→구매→관문→문제→분쟁 해결»을 본다. sandbox 키를 넣으면 같은 흐름이 실제 API로.
- 가장 큰 위험: sandbox에서 승인·부분 캡처·분쟁 생성이 실제로 되는지(사용자 sandbox 키가 있어야 확인 가능), 분쟁은 구매자가 Resolution Center에서 손으로 열어야 함.
- 지금 시험할 가장 작은 것: 미국 sandbox 계정으로 AUTHORIZE 주문 → 승인 → `final_capture:false` 캡처 2회.

## 구조
- `src/domain/` 순수 로직(돈·정책·관문·분쟁 사건·문구 가드·정산·감사 로그). IO 없음.
- `src/paypal/` 같은 인터페이스(`types.ts`)의 sandbox REST(`rest.ts`)와 시뮬레이터(`simulated.ts`).
- `src/catalog/` 데모 카탈로그(함정 포함)와 Channel3. `src/llm/` 공급자 교체와 세 가지 작업.
- `src/app/` 세션별 흐름, `src/server/` HTTP·스냅샷, `public/` 빌드 없는 UI.
- 검증: `npm test`(단위), `npm run eval`(종단 시나리오 24개, 처음 본 사례로 작성), `eval/drafts.ts`(LLM 문구 가드 통과율).

## 함정
- PayPal 미지원 통화(KRW)·소수 금지 통화(JPY·HUF·TWD)는 `money.ts`가 정본. 환산하지 않는다.
- Anthropic structured output 스키마에 `type: [t, "null"]` + enum null 조합을 쓰면 400. `anyOf`로 쓴다.
- 데모 상점 신뢰 점수는 함정 시나리오와 맞물려 있다(SoundPeak는 통과 점수여야 «주입 문구만으로 ASK»가 보인다).
- sandbox 모드에서 판매자 계정은 모든 방문자가 공유한다 → 판매자 화면은 자기 세션 주문의 분쟁만 보인다.
- sandbox에서 실제 분쟁이 없으면 «리허설 분쟁»(`src/paypal/rehearsal.ts`, id `REHEARSAL-`)으로 이어간다. 분쟁 자체는 PayPal에 안 가고, 환불만 실제 sandbox 환불(Payments v2). 화면·로그에 리허설이라고 표시한다 — 실제 분쟁처럼 보이게 하지 말 것.
- sandbox 키 확인: `npm run smoke:sandbox`(토큰+AUTHORIZE 주문+승인 링크), 승인 뒤 `npm run smoke:sandbox -- <orderId>`(부분 캡처 2회+void).
- 승인 없는 sandbox 호출 확인: `npm run smoke:sandbox2 -- <orderId> <captureId> [<captureId2>]`(환불 $0.50·같은 PayPal-Request-Id 재전송·track·인보이스·분쟁 목록). 환불은 캡처 잔액을 쓰므로 새 캡처로 돌린다.
- Invoicing은 REST 앱에서 **Invoicing 기능을 켜야** 한다. 꺼져 있으면 토큰에 invoicing scope가 없어 모든 호출이 `403 NOT_AUTHORIZED`(2026-11-06 실측, 키 문제처럼 보이니 주의). `rest.ts`가 이 403에 설정 안내를 붙인다.
- `REHEARSAL-` id는 세션에 없어도 PayPal로 보내지 않는다(`disputes.ts`의 `fetchDispute`).
