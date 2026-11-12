# resume.io API surface (from the shipped frontend)

Every HTTP call the web app's JavaScript can make, extracted statically from the production bundles on 2026-11-11 (rspack build, entry `assets/js/builder-729c146b.js`). `:id` marks a runtime path value; `=…` marks a runtime query value. A path listed here is one the client knows how to call; it does not prove the route is live for every account. See [TEARDOWN.md](TEARDOWN.md) for what each area does.

## Account, auth and sign-up

| Method | Path |
|---|---|
| DELETE | `/api/app/account` |
| POST | `/api/app/account` |
| PUT | `/api/app/account` |
| POST | `/api/app/account/extend-jwt` |
| DELETE | `/api/app/account/social-profile` |
| PATCH | `/api/app/account/ui-states` |
| DELETE | `/api/app/auth` |
| POST | `/api/app/auth/refresh` |
| POST | `/api/app/career-identity/activate` |
| POST | `/api/app/login/auth` |
| POST | `/api/app/login/change-password` |
| POST | `/api/app/login/magic-auth` |
| POST | `/api/app/login/magic-auth-of-rio` |
| POST | `/api/app/login/method` |
| POST | `/api/app/login/request-create-password` |
| POST | `/api/app/login/request-link` |
| POST | `/api/app/rio/magic_link` |
| GET | `/api/app/sign-up/payload` |
| POST | `/api/app/sign-up/register` |
| POST | `/api/app/sign-up/set_template` |
| POST | `/api/app/sign-up/validate` |
| GET | `/api/app/users/initialize?token=…` |

## Billing and subscription

| Method | Path |
|---|---|
| POST | `/api/api/builder/subscription/apply_cancellation_coupon` |
| GET | `/api/api/builder/subscription/cancellation_coupon_options` |
| GET | `/api/api/builder/subscription/cancellation_coupon_stats` |
| POST | `/api/api/builder/subscription/pause` |
| POST | `/api/api/builder/subscription/restart_subscription` |
| GET | `/api/app/billing/plans` |
| GET | `/api/app/billing/plans/addon` |
| GET | `/api/app/billing/plans/scenario` |
| POST | `/api/app/billing/plans/visit` |
| GET | `/api/app/payment-plans/list-coaching-plans` |
| GET | `/api/app/payment-plans/min-plan-price` |
| DELETE | `/api/app/subscription` |
| POST | `/api/app/subscription/abandoned_discount` |
| POST | `/api/app/subscription/cancellation_discount` |
| POST | `/api/app/subscription/pause` |
| POST | `/api/app/subscription/stay_in_touch_discount` |
| GET | `/app/billing/charge_bee/adyen_config` |
| GET | `/app/billing/charge_bee/payment_methods` |

## Resumes, cover letters and documents

| Method | Path |
|---|---|
| GET | `/api/app/:id/suggest/:id` |
| GET | `/api/app/:id/templates` |
| GET | `/api/app/cover-letters` |
| POST | `/api/app/cover-letters` |
| GET | `/api/app/cover-letters/:id` |
| PATCH | `/api/app/cover-letters/:id` |
| PUT | `/api/app/cover-letters/:id` |
| GET | `/api/app/cover-letters/:id/template` |
| GET | `/api/app/examples/categories` |
| GET | `/api/app/examples/filters` |
| GET | `/api/app/examples/search` |
| GET | `/api/app/general/editor-payload` |
| PATCH | `/api/app/linkedin-data-profile/prefill-resume?linkedin_profile=…&resume_id=…` |
| PATCH | `/api/app/linkedin-data-profile/prefill-resume?linkedin_profile=…&resume_id=…&ai_enhanced=true` |
| GET | `/api/app/linkedin-data-profile/profile?linkedin_profile=…` |
| GET | `/api/app/phrases/:id/search` |
| POST | `/api/app/phrases/:id/use?locale=…` |
| POST | `/api/app/post-cv` |
| POST | `/api/app/resume-parser/parse-resume` |
| POST | `/api/app/resume-parser/parse-resume-data` |
| POST | `/api/app/resume-parser/parse-top-resume-doc?document_id=…` |
| GET | `/api/app/resumes` |
| POST | `/api/app/resumes` |
| GET | `/api/app/resumes/:id` |
| PATCH | `/api/app/resumes/:id` |
| PUT | `/api/app/resumes/:id` |
| POST | `/api/app/resumes/:id/ai-resume-full-review` |
| GET | `/api/app/resumes/:id/ai-resume-full-review/last-review` |
| POST | `/api/app/resumes/:id/critique` |
| POST | `/api/app/resumes/:id/critique/create-free-critique?checksum=…` |
| POST | `/api/app/resumes/:id/duplicate` |
| POST | `/api/app/resumes/:id/photo` |
| POST | `/api/app/resumes/:id/prefill/:id` |
| GET | `/api/app/resumes/:id/prefill/status` |
| GET | `/api/app/resumes/:id/resume_as_string` |
| POST | `/api/app/resumes/:id/send-to-review` |
| POST | `/api/app/resumes/:id/send_feedback` |
| PUT | `/api/app/resumes/:id/use_example` |
| GET | `/api/app/resumes/templates` |
| GET | `/api/app/sharing/:id` |
| POST | `/api/app/sharing/:id/activate` |
| GET | `/api/app/sharing/:id/history` |
| DELETE | `/api/app/{resumes|cover-letters}/:id` |
| GET | `/api/app/{resumes|cover-letters}/:id` |
| POST | `/api/app/{resumes|cover-letters}/:id/rename` |
| GET | `/api/app/{resumes|cover-letters}/:id/template` |
| POST | `/api/builder/resume_upload/register` |
| POST | `/api/builder/resume_upload/upload_and_parse` |
| GET | `/api/documents` |
| GET | `/api/documents/:id` |
| PUT | `/api/documents/:id` |
| POST | `/api/documents/:id/duplicate` |
| POST | `/api/documents/:id/duplicate_cover_letter` |
| GET | `/api/tailored_resumes` |

## Scoring, tailoring and job postings

| Method | Path |
|---|---|
| POST | `/api/job-postings` |
| GET | `/api/job-postings/:id` |
| POST | `/api/job-postings/generate-cover-letter` |
| POST | `/api/job-postings/regenerate-cover-letter` |
| DELETE | `/api/job-postings/soft_delete` |
| POST | `/api/job-postings/update_selected_resume` |
| GET | `/api/resumes/:id/review` |
| POST | `/api/resumes/:id/review` |
| PUT | `/api/resumes/:id/review` |
| POST | `/api/resumes/:id/scoring` |
| PUT | `/api/resumes/:id/scoring` |
| POST | `/api/resumes/:id/tailoring` |

## AI writing, review and chat

| Method | Path |
|---|---|
| GET | `/api/ai_coach/v1/ai_coach/history` |
| POST | `/api/ai_coach/v1/ai_coach/prompt` |
| POST | `/api/app/ai-copilot/chat` |
| PUT | `/api/app/ai-resume-draft/:id` |
| POST | `/api/app/ai-resume-draft/speech_to_text` |
| GET | `/api/app/features/resume-review` |
| GET | `/api/app/resume-critiques` |
| POST | `/api/app/tr-critique-details?resume_id=…&is_top_resume_user=…` |
| GET | `/api/app/tr-leads?checksum=…&is_cio_user=…&email=…&redirect_to=…?critique_review=…` |
| POST | `/api/app/update-critique-popup-viewed-at?resume_id=…` |

## Job search, alerts and recommendations

| Method | Path |
|---|---|
| POST | `/api/career/v1/profile/exclude_job` |
| GET | `/api/career/v1/recommended-jobs` |
| GET | `/api/job-alerts/v1/custom-subscriptions` |
| POST | `/api/job-alerts/v1/custom-subscriptions` |
| DELETE | `/api/job-alerts/v1/custom-subscriptions/:id` |
| GET | `/api/job-alerts/v1/custom-subscriptions/:id` |
| PUT | `/api/job-alerts/v1/custom-subscriptions/:id` |
| GET | `/api/job-alerts/v1/recommendation-subscription` |
| PUT | `/api/job-alerts/v1/recommendation-subscription` |
| GET | `/api/jobs/v1/search` |
| GET | `/api/jobs/v1/search/:id` |
| GET | `/api/jobs/v1/search/companies/jobs-count` |
| GET | `/api/jobs/v1/search/company/:id` |
| GET | `/api/jobs/v1/search/location` |
| GET | `/api/jobs/v1/search/location/:id` |
| GET | `/api/jobs/v1/search/similar-jobs` |
| GET | `/api/jobs/v1/search/suggest-locations` |

## Job tracker and Auto Apply

| Method | Path |
|---|---|
| POST | `/api/app/job-cards/:id/auto-apply-documents` |
| DELETE | `/api/app/job-cards/:id/auto-apply-documents/:id` |
| GET | `/api/app/job-statuses` |
| POST | `/api/app/job-statuses/update-job-status` |
| GET | `/api/auto-apply-copilots` |
| POST | `/api/auto-apply-copilots` |
| GET | `/api/auto-apply-copilots/:id` |
| PATCH | `/api/auto-apply-copilots/:id` |
| GET | `/api/auto-apply-copilots/stats` |
| GET | `/api/auto-apply-stats` |
| PUT | `/api/job-board/sync-cards` |
| GET | `/api/job-cards` |
| POST | `/api/job-cards` |
| DELETE | `/api/job-cards/:id` |
| GET | `/api/job-cards/:id` |
| PATCH | `/api/job-cards/:id` |
| PUT | `/api/job-cards/:id` |
| PATCH | `/api/job-cards/:id/document-overwrite` |
| POST | `/api/job-cards/:id/retry_auto_tailoring` |
| POST | `/api/job-cards/:id/submit_application` |
| GET | `/api/job-cards/applied_status` |
| GET | `/api/job-cards/statuses` |

## Career profile and career data

| Method | Path |
|---|---|
| GET | `/api/career-data/v1/attributes` |
| GET | `/api/career-data/v1/courses` |
| GET | `/api/career-data/v1/fuzzy-job-titles` |
| GET | `/api/career-data/v1/job-progression` |
| GET | `/api/career-data/v1/job-titles` |
| GET | `/api/career-data/v1/job-titles/:id` |
| GET | `/api/career-data/v1/resume-skills` |
| GET | `/api/career-data/v1/salary` |
| POST | `/api/career-data/v1/salary-feedback` |
| GET | `/api/career-data/v1/skills` |
| GET | `/api/career-data/v1/title-skills` |
| GET | `/api/career/profile` |
| PATCH | `/api/career/profile` |
| GET | `/api/career/v1/assessments` |
| POST | `/api/career/v1/assessments` |
| GET | `/api/career/v1/insights` |
| GET | `/api/career/v1/profile/completeness-state` |
| POST | `/api/career/v1/profile/prefill/me` |

## Interview prep

| Method | Path |
|---|---|
| GET | `/api/interview_prep/company_interviews` |
| GET | `/api/interview_prep/daily_suggestions?data_api_job_title_id=…` |
| GET | `/api/interview_prep/interviews` |
| POST | `/api/interview_prep/interviews` |
| DELETE | `/api/interview_prep/interviews/:id` |
| GET | `/api/interview_prep/interviews/:id` |
| PATCH | `/api/interview_prep/interviews/:id` |
| POST | `/api/interview_prep/interviews/:id/create_from_interview` |
| POST | `/api/interview_prep/interviews/:id/create_from_interview_with_new_questions` |
| GET | `/api/interview_prep/interviews/:id/questions/:id/follow_up_questions` |
| GET | `/api/interview_prep/interviews/:id/questions/:id/stream_audio` |
| POST | `/api/interview_prep/interviews/create_from_template?question_template_id=…` |
| POST | `/api/interview_prep/interviews/set_user_job_title_id` |
| GET | `/api/interview_prep/question_templates` |
| DELETE | `/api/interview_prep/questions/:id/answer` |
| PATCH | `/api/interview_prep/questions/:id/answer` |
| POST | `/api/interview_prep/questions/:id/answer` |
| POST | `/api/interview_prep/questions/:id/answer/complete_{type}` |
| GET | `/api/interview_prep/questions/:id/answer?part_number=…` |
| GET | `/api/interview_prep/ws/presigned_url` |

## Resume distribution

| Method | Path |
|---|---|
| GET | `/api/resume-distribution/candidates` |
| PATCH | `/api/resume-distribution/candidates` |
| POST | `/api/resume-distribution/candidates` |
| GET | `/api/resume-distribution/candidates/distributed-resume` |
| GET | `/api/resume-distribution/candidates/recruiters` |
| POST | `/api/resume-distribution/candidates/resume` |
| POST | `/api/resume-distribution/candidates/subscription/pause` |
| POST | `/api/resume-distribution/candidates/subscription/resume` |
| POST | `/api/resume-distribution/candidates/subscriptions` |
| GET | `/api/resume-distribution/recruiters/count` |

## Coaching, career plans and pathways

| Method | Path |
|---|---|
| GET | `/api/app/career-pathways/v2/cards` |
| POST | `/api/app/career-pathways/v2/cards` |
| DELETE | `/api/app/career-pathways/v2/cards/:id` |
| PUT | `/api/app/career-pathways/v2/cards/:id` |
| POST | `/api/app/career-planning/:id/cta-complete` |
| GET | `/api/app/career-planning/all-content` |
| POST | `/api/app/career-planning/assessments/accomplishments` |
| GET | `/api/app/career-planning/assessments/seven-stories-exercise` |
| POST | `/api/app/career-planning/assessments/seven-stories-exercise` |
| GET | `/api/app/career-planning/content` |
| GET | `/api/app/career-planning/cta-progress` |
| GET | `/api/app/career-planning/headings` |
| GET | `/api/app/career-planning/user-last-section` |
| POST | `/api/app/career-planning/user-last-section` |
| POST | `/api/app/coaching/assign` |
| GET | `/api/app/coaching/career-coach-detail` |
| GET | `/api/app/coaching/career-industries` |
| GET | `/api/app/coaching/career-industries?query=…&limit=10` |
| GET | `/api/app/coaching/career-industries?suggested=true&limit=7` |
| GET | `/api/app/coaching/career-levels` |
| GET | `/api/app/coaching/career-services` |
| GET | `/api/app/coaching/coach-listing` |
| GET | `/api/app/coaching/get-coach-booking-slot` |
| GET | `/api/app/coaching/redirection` |
| GET | `/api/app/coaching/sessions` |
| POST | `/api/app/coaching/user-coach-preferences` |
| PATCH | `/api/app/coaching/user-coach-preferences/:id` |
| GET | `/api/app/coaching/user-coach-preferences/current-user-preference` |
| POST | `/api/app/offer-analyzer/internal_create` |
| GET | `/api/learning/users` |
| POST | `/api/learning/users/create_redirect_link` |

## Dashboard, onboarding widgets and feedback

| Method | Path |
|---|---|
| GET | `/api/app/config` |
| POST | `/api/app/feedback/rate` |
| POST | `/api/app/feedback/save-rating` |
| POST | `/api/app/feedback/trustpilot-link` |
| GET | `/api/app/translations/:id/:id` |
| POST | `/api/app/update-smart-banner-order` |
| POST | `/api/app/widget-steps/:id` |
| GET | `/api/app/widget-steps?name=…` |
| GET | `/api/dashboard-stepper` |
| POST | `/api/dashboard-stepper/complete_step?step=personalized_jobs` |
| POST | `/api/dashboard-stepper/complete_step?step=stepper_success_state_seen` |
| GET | `/api/dashboard-stepper/step_status?step=stepper_success_state_seen` |
| GET | `/api/stepper/dashboard` |
| GET | `/api/trustpilot` |

## Calls to other hosts

| Method | URL | Purpose |
|---|---|---|
| GET | `https://ssr.resume.tools/to-pdf/:renderingToken?token&version&download=1` | Final PDF download |
| GET | `https://ssr.resume.tools/to-docx/:renderingToken?token&template&version` | Final DOCX download |
| GET | `https://ssr.resume.tools/to-image/:renderingToken-:page.{webp,jpg}?cache&size` | Page thumbnails and preview fallback |
| POST | `https://ssr.resume.tools/openai-realtime-token` | Short-lived token for voice dictation |
| WSS | `wss://api.openai.com/v1/realtime` | Speech-to-text for the AI resume draft |
| POST | `https://spell.resume.io/spellcheck` | Spellcheck `{text, locale}` → `incorrectWords` |
| GET | `https://spell.resume.io/info` | Supported spellcheck locales |
| POST | `https://bg-service.resume.io/rembg` | Photo background removal |
| GET | `https://mcp.resume.io/api/resumes/:id` | Import a resume drafted through their MCP server into the guest builder |
| GET | `https://headsome.resume.tools/44/:seed.svg` | Generated avatars |
| GET | `https://lloyd.career.io/users/initialize?token` | Cross-product sign-in with career.io |
