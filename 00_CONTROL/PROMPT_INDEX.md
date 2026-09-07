# FdbTrade Prompt Pack Index v1.0

Approved source: FdbTrade Blueprint v2.0.

| Prompt | Phase | Title | File |
|---|---|---|---|
| P00-01 | Constitution | Inspect runtime and establish project constitution | `01_PROMPTS/P00_Constitution/P00-01_Inspect_runtime_and_establish_project_constitution.md` |
| P00-02 | Constitution | Create repository skeleton and workspace contracts | `01_PROMPTS/P00_Constitution/P00-02_Create_repository_skeleton_and_workspace_contracts.md` |
| P00-03 | Constitution | Create configuration and environment contract | `01_PROMPTS/P00_Constitution/P00-03_Create_configuration_and_environment_contract.md` |
| P00-04 | Constitution | Establish CI baseline and ADR system | `01_PROMPTS/P00_Constitution/P00-04_Establish_CI_baseline_and_ADR_system.md` |
| P01-01 | Foundation | Build web application shell | `01_PROMPTS/P01_Foundation/P01-01_Build_web_application_shell.md` |
| P01-02 | Foundation | Build API foundation | `01_PROMPTS/P01_Foundation/P01-02_Build_API_foundation.md` |
| P01-03 | Foundation | Initialize PostgreSQL and migrations | `01_PROMPTS/P01_Foundation/P01-03_Initialize_PostgreSQL_and_migrations.md` |
| P01-04 | Foundation | Implement authentication foundation | `01_PROMPTS/P01_Foundation/P01-04_Implement_authentication_foundation.md` |
| P02-01 | Data Core | Define market data canonical model | `01_PROMPTS/P02_Data_Core/P02-01_Define_market_data_canonical_model.md` |
| P02-02 | Data Core | Create provider interfaces and fixture adapter | `01_PROMPTS/P02_Data_Core/P02-02_Create_provider_interfaces_and_fixture_adapter.md` |
| P02-03 | Data Core | Implement normalizer and validator | `01_PROMPTS/P02_Data_Core/P02-03_Implement_normalizer_and_validator.md` |
| P02-04 | Data Core | Add cache and ingestion worker | `01_PROMPTS/P02_Data_Core/P02-04_Add_cache_and_ingestion_worker.md` |
| P02-05 | Data Core | Add historical dataset manifest | `01_PROMPTS/P02_Data_Core/P02-05_Add_historical_dataset_manifest.md` |
| P03-01 | Feature Core | Define feature schema and lineage | `01_PROMPTS/P03_Feature_Core/P03-01_Define_feature_schema_and_lineage.md` |
| P03-02 | Feature Core | Implement core indicators | `01_PROMPTS/P03_Feature_Core/P03-02_Implement_core_indicators.md` |
| P03-03 | Feature Core | Implement market-structure features | `01_PROMPTS/P03_Feature_Core/P03-03_Implement_market-structure_features.md` |
| P03-04 | Feature Core | Implement snapshot/lineage store | `01_PROMPTS/P03_Feature_Core/P03-04_Implement_snapshot_lineage_store.md` |
| P04-01 | Regime Engine | Define regime contract | `01_PROMPTS/P04_Regime_Engine/P04-01_Define_regime_contract.md` |
| P04-02 | Regime Engine | Implement deterministic baseline regime classifier | `01_PROMPTS/P04_Regime_Engine/P04-02_Implement_deterministic_baseline_regime_classifier.md` |
| P04-03 | Regime Engine | Add multi-timeframe regime context | `01_PROMPTS/P04_Regime_Engine/P04-03_Add_multi-timeframe_regime_context.md` |
| P04-04 | Regime Engine | Add regime diagnostics | `01_PROMPTS/P04_Regime_Engine/P04-04_Add_regime_diagnostics.md` |
| P05-01 | Strategy Core | Define strategy interface and signal contract v2 | `01_PROMPTS/P05_Strategy_Core/P05-01_Define_strategy_interface_and_signal_contract_v2.md` |
| P05-02 | Strategy Core | Implement trend-following baseline | `01_PROMPTS/P05_Strategy_Core/P05-02_Implement_trend-following_baseline.md` |
| P05-03 | Strategy Core | Implement breakout baseline | `01_PROMPTS/P05_Strategy_Core/P05-03_Implement_breakout_baseline.md` |
| P05-04 | Strategy Core | Implement mean-reversion baseline | `01_PROMPTS/P05_Strategy_Core/P05-04_Implement_mean-reversion_baseline.md` |
| P05-05 | Strategy Core | Implement momentum baseline | `01_PROMPTS/P05_Strategy_Core/P05-05_Implement_momentum_baseline.md` |
| P05-06 | Strategy Core | Add signal lifecycle and expiry | `01_PROMPTS/P05_Strategy_Core/P05-06_Add_signal_lifecycle_and_expiry.md` |
| P06-01 | Alpha Ensemble | Create ensemble contract | `01_PROMPTS/P06_Alpha_Ensemble/P06-01_Create_ensemble_contract.md` |
| P06-02 | Alpha Ensemble | Implement static baseline weighting | `01_PROMPTS/P06_Alpha_Ensemble/P06-02_Implement_static_baseline_weighting.md` |
| P06-03 | Alpha Ensemble | Implement cost-aware edge gate | `01_PROMPTS/P06_Alpha_Ensemble/P06-03_Implement_cost-aware_edge_gate.md` |
| P06-04 | Alpha Ensemble | Implement confidence and calibration layer | `01_PROMPTS/P06_Alpha_Ensemble/P06-04_Implement_confidence_and_calibration_layer.md` |
| P06-05 | Alpha Ensemble | Implement decision ranking | `01_PROMPTS/P06_Alpha_Ensemble/P06-05_Implement_decision_ranking.md` |
| P07-01 | Signal UX | Build private command center | `01_PROMPTS/P07_Signal_UX/P07-01_Build_private_command_center.md` |
| P07-02 | Signal UX | Build scanner | `01_PROMPTS/P07_Signal_UX/P07-02_Build_scanner.md` |
| P07-03 | Signal UX | Build signal detail | `01_PROMPTS/P07_Signal_UX/P07-03_Build_signal_detail.md` |
| P07-04 | Signal UX | Build chart and signal overlays | `01_PROMPTS/P07_Signal_UX/P07-04_Build_chart_and_signal_overlays.md` |
| P07-05 | Signal UX | Build alert center | `01_PROMPTS/P07_Signal_UX/P07-05_Build_alert_center.md` |
| P08-01 | Backtest Engine | Define event-driven backtest model | `01_PROMPTS/P08_Backtest_Engine/P08-01_Define_event-driven_backtest_model.md` |
| P08-02 | Backtest Engine | Implement realistic fill/cost model | `01_PROMPTS/P08_Backtest_Engine/P08-02_Implement_realistic_fill_cost_model.md` |
| P08-03 | Backtest Engine | Implement metrics engine | `01_PROMPTS/P08_Backtest_Engine/P08-03_Implement_metrics_engine.md` |
| P08-04 | Backtest Engine | Implement golden backtest fixtures | `01_PROMPTS/P08_Backtest_Engine/P08-04_Implement_golden_backtest_fixtures.md` |
| P08-05 | Backtest Engine | Build backtest API and run artifacts | `01_PROMPTS/P08_Backtest_Engine/P08-05_Build_backtest_API_and_run_artifacts.md` |
| P09-01 | Research Lab | Implement train/validation/test time splits | `01_PROMPTS/P09_Research_Lab/P09-01_Implement_train_validation_test_time_splits.md` |
| P09-02 | Research Lab | Implement walk-forward evaluation | `01_PROMPTS/P09_Research_Lab/P09-02_Implement_walk-forward_evaluation.md` |
| P09-03 | Research Lab | Implement purged/embargoed validation | `01_PROMPTS/P09_Research_Lab/P09-03_Implement_purged_embargoed_validation.md` |
| P09-04 | Research Lab | Implement stress testing and Monte Carlo | `01_PROMPTS/P09_Research_Lab/P09-04_Implement_stress_testing_and_Monte_Carlo.md` |
| P09-05 | Research Lab | Implement strategy promotion registry | `01_PROMPTS/P09_Research_Lab/P09-05_Implement_strategy_promotion_registry.md` |
| P10-01 | Paper Broker | Define paper order state machine | `01_PROMPTS/P10_Paper_Broker/P10-01_Define_paper_order_state_machine.md` |
| P10-02 | Paper Broker | Implement paper fill simulator | `01_PROMPTS/P10_Paper_Broker/P10-02_Implement_paper_fill_simulator.md` |
| P10-03 | Paper Broker | Implement paper position ledger | `01_PROMPTS/P10_Paper_Broker/P10-03_Implement_paper_position_ledger.md` |
| P10-04 | Paper Broker | Implement reconciliation loop | `01_PROMPTS/P10_Paper_Broker/P10-04_Implement_reconciliation_loop.md` |
| P11-01 | Risk Engine | Define independent risk service boundary | `01_PROMPTS/P11_Risk_Engine/P11-01_Define_independent_risk_service_boundary.md` |
| P11-02 | Risk Engine | Implement hard limits and sizing | `01_PROMPTS/P11_Risk_Engine/P11-02_Implement_hard_limits_and_sizing.md` |
| P11-03 | Risk Engine | Implement portfolio heat and correlation controls | `01_PROMPTS/P11_Risk_Engine/P11-03_Implement_portfolio_heat_and_correlation_controls.md` |
| P11-04 | Risk Engine | Implement risk states and kill switch | `01_PROMPTS/P11_Risk_Engine/P11-04_Implement_risk_states_and_kill_switch.md` |
| P11-05 | Risk Engine | Add risk observability | `01_PROMPTS/P11_Risk_Engine/P11-05_Add_risk_observability.md` |
| P12-01 | Analytics | Build trade outcome analytics | `01_PROMPTS/P12_Analytics/P12-01_Build_trade_outcome_analytics.md` |
| P12-02 | Analytics | Build calibration analytics | `01_PROMPTS/P12_Analytics/P12-02_Build_calibration_analytics.md` |
| P12-03 | Analytics | Build MAE/MFE analytics | `01_PROMPTS/P12_Analytics/P12-03_Build_MAE_MFE_analytics.md` |
| P12-04 | Analytics | Build attribution and regime analytics | `01_PROMPTS/P12_Analytics/P12-04_Build_attribution_and_regime_analytics.md` |
| P13-01 | Admin & Observability | Implement structured logging/tracing | `01_PROMPTS/P13_Admin_&_Observability/P13-01_Implement_structured_logging_tracing.md` |
| P13-02 | Admin & Observability | Build audit log | `01_PROMPTS/P13_Admin_&_Observability/P13-02_Build_audit_log.md` |
| P13-03 | Admin & Observability | Build strategy/model registry UI | `01_PROMPTS/P13_Admin_&_Observability/P13-03_Build_strategy_model_registry_UI.md` |
| P13-04 | Admin & Observability | Build provider/system health dashboard | `01_PROMPTS/P13_Admin_&_Observability/P13-04_Build_provider_system_health_dashboard.md` |
| P13-05 | Admin & Observability | Build operational controls | `01_PROMPTS/P13_Admin_&_Observability/P13-05_Build_operational_controls.md` |
| P14-01 | Hardening | Security hardening | `01_PROMPTS/P14_Hardening/P14-01_Security_hardening.md` |
| P14-02 | Hardening | Performance/load hardening | `01_PROMPTS/P14_Hardening/P14-02_Performance_load_hardening.md` |
| P14-03 | Hardening | Chaos/failure testing | `01_PROMPTS/P14_Hardening/P14-03_Chaos_failure_testing.md` |
| P14-04 | Hardening | CI/CD and environment promotion | `01_PROMPTS/P14_Hardening/P14-04_CI_CD_and_environment_promotion.md` |
| P14-05 | Hardening | Backups/restore and runbooks | `01_PROMPTS/P14_Hardening/P14-05_Backups_restore_and_runbooks.md` |
| P15-01 | Broker Read-only | Finalize broker adapter contract | `01_PROMPTS/P15_Broker_Read-only/P15-01_Finalize_broker_adapter_contract.md` |
| P15-02 | Broker Read-only | Implement MT5 read-only adapter | `01_PROMPTS/P15_Broker_Read-only/P15-02_Implement_MT5_read-only_adapter.md` |
| P15-03 | Broker Read-only | Implement quote/account sync | `01_PROMPTS/P15_Broker_Read-only/P15-03_Implement_quote_account_sync.md` |
| P15-04 | Broker Read-only | Implement broker health and drift checks | `01_PROMPTS/P15_Broker_Read-only/P15-04_Implement_broker_health_and_drift_checks.md` |
| P16-01 | Demo Execution | Open execution adapter only for demo | `01_PROMPTS/P16_Demo_Execution/P16-01_Open_execution_adapter_only_for_demo.md` |
| P16-02 | Demo Execution | Implement idempotent order submission | `01_PROMPTS/P16_Demo_Execution/P16-02_Implement_idempotent_order_submission.md` |
| P16-03 | Demo Execution | Implement partial fills/rejects/timeouts | `01_PROMPTS/P16_Demo_Execution/P16-03_Implement_partial_fills_rejects_timeouts.md` |
| P16-04 | Demo Execution | Implement demo monitoring and rollback | `01_PROMPTS/P16_Demo_Execution/P16-04_Implement_demo_monitoring_and_rollback.md` |
| P17-01 | Live Gate | Implement live preflight checklist | `01_PROMPTS/P17_Live_Gate/P17-01_Implement_live_preflight_checklist.md` |
| P17-02 | Live Gate | Implement manual approval workflow | `01_PROMPTS/P17_Live_Gate/P17-02_Implement_manual_approval_workflow.md` |
| P17-03 | Live Gate | Implement tiny-live pilot controls | `01_PROMPTS/P17_Live_Gate/P17-03_Implement_tiny-live_pilot_controls.md` |
| P17-04 | Live Gate | Implement live rollback and circuit breakers | `01_PROMPTS/P17_Live_Gate/P17-04_Implement_live_rollback_and_circuit_breakers.md` |
| P17-05 | Live Gate | Build post-live review | `01_PROMPTS/P17_Live_Gate/P17-05_Build_post-live_review.md` |
| P18-01 | Advanced Alpha | Implement meta-labeling research pipeline | `01_PROMPTS/P18_Advanced_Alpha/P18-01_Implement_meta-labeling_research_pipeline.md` |
| P18-02 | Advanced Alpha | Add ML challenger framework | `01_PROMPTS/P18_Advanced_Alpha/P18-02_Add_ML_challenger_framework.md` |
| P18-03 | Advanced Alpha | Add multi-provider research comparison | `01_PROMPTS/P18_Advanced_Alpha/P18-03_Add_multi-provider_research_comparison.md` |
| P18-04 | Advanced Alpha | Add portfolio intelligence engine | `01_PROMPTS/P18_Advanced_Alpha/P18-04_Add_portfolio_intelligence_engine.md` |
| P18-05 | Advanced Alpha | Add online/adaptive research safely | `01_PROMPTS/P18_Advanced_Alpha/P18-05_Add_online_adaptive_research_safely.md` |
| P18-06 | Advanced Alpha | Build advanced feature research sandbox | `01_PROMPTS/P18_Advanced_Alpha/P18-06_Build_advanced_feature_research_sandbox.md` |