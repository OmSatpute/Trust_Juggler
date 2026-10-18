import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Modal,
  Platform,
  ActivityIndicator,
} from 'react-native';

import {
  buildCustomScenario,
  QUICK_SCENARIO_PRESETS,
} from './mock/scenarioEngine.js';

// Safe text helper
const safeStr = (val, fallback = 'N/A') => (val != null && val !== '' ? String(val) : fallback);
const safeNum = (val, fallback = '--') => (val != null && !isNaN(val) ? String(val) : fallback);

/**
 * CustomScenarioModal Component
 * Dedicated modal screen for configuring and executing custom multi-signal mock scenarios.
 */
export default function CustomScenarioModal({
  visible,
  onClose,
  onStage1Result,
  initialPresetId = null,
}) {
  // Configuration State
  const [riderChoice, setRiderChoice] = useState('regular'); // 'regular' | 'new_device' | 'unusual_pattern'
  const [gpsChoice, setGpsChoice] = useState('normal'); // 'normal' | 'nearby' | 'impossible' | 'unavailable'
  const [sessionChoice, setSessionChoice] = useState('normal'); // 'normal' | 'off_hours' | 'unknown_device' | 'suspicious'
  const [networkChoice, setNetworkChoice] = useState('normal_network'); // 'normal_network' | 'different_ip' | 'unavailable'

  // Execution & Results State
  const [isCalculating, setIsCalculating] = useState(false);
  const [scenarioResult, setScenarioResult] = useState(null);
  const [dispatched, setDispatched] = useState(false);

  // Expandable Section States
  const [showGpsDetails, setShowGpsDetails] = useState(false);
  const [showSessionDetails, setShowSessionDetails] = useState(false);
  const [showNetworkDetails, setShowNetworkDetails] = useState(false);
  const [showJsonPayload, setShowJsonPayload] = useState(false);

  // Load a Quick Preset into the configuration
  const handleApplyPreset = (preset) => {
    setRiderChoice(preset.config.riderChoice);
    setGpsChoice(preset.config.gpsChoice);
    setSessionChoice(preset.config.sessionChoice);
    setNetworkChoice(preset.config.networkChoice);
    setScenarioResult(null);
    setDispatched(false);
  };

  // Reset to clean sensible defaults
  const handleClearSelection = () => {
    setRiderChoice('regular');
    setGpsChoice('normal');
    setSessionChoice('normal');
    setNetworkChoice('normal_network');
    setScenarioResult(null);
    setDispatched(false);
  };

  // Run the Scenario Engine
  const handleRunScenario = () => {
    if (isCalculating) return; // Prevent duplicate submissions
    setIsCalculating(true);

    // Brief simulated calculation delay for smooth UI feedback
    setTimeout(() => {
      const result = buildCustomScenario({
        scenarioName: 'Evaluated Custom Scenario',
        riderChoice,
        gpsChoice,
        sessionChoice,
        networkChoice,
      });

      setScenarioResult(result);
      setIsCalculating(false);
      setDispatched(false);
    }, 150);
  };

  // Dispatch evaluated payload to the parent pipeline callback
  const handleDispatchPayload = () => {
    if (scenarioResult && typeof onStage1Result === 'function') {
      onStage1Result(scenarioResult.payload);
      setDispatched(true);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>
        {/* Modal Top Navigation Bar */}
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={onClose}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Back to Dashboard"
          >
            <Text style={styles.backButtonText}>← Dashboard</Text>
          </TouchableOpacity>

          <View style={styles.topBarTitleContainer}>
            <Text style={styles.topBarTitle}>Custom Scenario Builder</Text>
            <View style={styles.simBadge}>
              <Text style={styles.simBadgeText}>SIMULATED</Text>
            </View>
          </View>
        </View>

        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* ==================================================
              RESULTS VIEW (If scenario was executed)
             ================================================== */}
          {scenarioResult ? (
            <View style={styles.resultsContainer}>
              {/* Overall Assessment Header Card */}
              <View
                style={[
                  styles.assessmentCard,
                  scenarioResult.badgeType === 'danger'
                    ? styles.assessmentDanger
                    : scenarioResult.badgeType === 'warning'
                    ? styles.assessmentWarning
                    : styles.assessmentSuccess,
                ]}
              >
                <View style={styles.assessmentHeaderRow}>
                  <Text style={styles.assessmentHeading}>Overall Assessment</Text>
                  <View
                    style={[
                      styles.assessmentBadge,
                      scenarioResult.badgeType === 'danger'
                        ? styles.pillDanger
                        : scenarioResult.badgeType === 'warning'
                        ? styles.pillWarning
                        : styles.pillSuccess,
                    ]}
                  >
                    <Text style={styles.assessmentBadgeText}>
                      {scenarioResult.overallAssessment}
                    </Text>
                  </View>
                </View>
                <Text style={styles.assessmentGuidanceText}>
                  {scenarioResult.assessmentGuidance}
                </Text>
              </View>

              {/* Compact Results Summary (Part 6) */}
              <View style={styles.card}>
                <Text style={styles.cardSectionTitle}>Scenario Summary</Text>

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Selected Rider:</Text>
                  <Text style={styles.summaryValueBold}>
                    {scenarioResult.summary.riderName}
                  </Text>
                </View>

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>GPS Status:</Text>
                  <Text style={styles.summaryValue}>
                    {scenarioResult.summary.gpsStatus}
                  </Text>
                </View>

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Device Status:</Text>
                  <Text style={styles.summaryValue}>
                    {scenarioResult.summary.deviceStatus}
                  </Text>
                </View>

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Session Status:</Text>
                  <Text style={styles.summaryValue}>
                    {scenarioResult.summary.sessionStatus}
                  </Text>
                </View>

                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Network Status:</Text>
                  <Text style={styles.summaryValue}>
                    {scenarioResult.summary.networkStatus}
                  </Text>
                </View>

                {/* Simultaneous Risk Signals */}
                <View style={styles.riskSignalsRow}>
                  <Text style={styles.summaryLabel}>Signals Detected:</Text>
                  <View style={styles.tagWrap}>
                    {scenarioResult.riskFlags.map((flag, idx) => (
                      <View
                        key={idx}
                        style={[
                          styles.flagTag,
                          flag === 'IMPOSSIBLE_TRAVEL' && styles.flagTagDanger,
                          (flag === 'OFF_HOURS_LOGIN' ||
                            flag === 'UNRECOGNIZED_DEVICE' ||
                            flag === 'LOCATION_UNAVAILABLE' ||
                            flag === 'NETWORK_UNAVAILABLE') &&
                            styles.flagTagWarning,
                          flag === 'STAGE_1_PASSED' && styles.flagTagSuccess,
                        ]}
                      >
                        <Text style={styles.flagTagText}>{flag}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>

              {/* Expandable Section 1: Detailed GPS Calculations */}
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.accordionHeader}
                  onPress={() => setShowGpsDetails(!showGpsDetails)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.accordionTitle}>
                    {showGpsDetails ? '▼' : '▶'} Detailed GPS Calculations
                  </Text>
                  <Text style={styles.accordionSub}>
                    {scenarioResult.gps.isUnavailable
                      ? 'Unavailable'
                      : `${safeNum(scenarioResult.gps.distanceKm)} km | ${safeNum(scenarioResult.gps.velocityKmh)} km/h`}
                  </Text>
                </TouchableOpacity>

                {showGpsDetails && (
                  <View style={styles.accordionBody}>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Origin Location:</Text>
                      <Text style={styles.fieldValueText}>
                        {safeStr(scenarioResult.gps.previousLocation)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Origin Coordinates:</Text>
                      <Text style={styles.fieldMonospace}>
                        {safeStr(scenarioResult.gps.previousCoordinatesFormatted)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Destination Location:</Text>
                      <Text style={styles.fieldValueText}>
                        {safeStr(scenarioResult.gps.currentLocation)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Destination Coordinates:</Text>
                      <Text style={styles.fieldMonospace}>
                        {safeStr(scenarioResult.gps.currentCoordinatesFormatted)}
                      </Text>
                    </View>
                    <View style={styles.fieldDivider} />
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Haversine Distance:</Text>
                      <Text style={styles.fieldValueHighlight}>
                        {scenarioResult.gps.isUnavailable
                          ? 'null (Unavailable)'
                          : `${safeNum(scenarioResult.gps.distanceKm)} km`}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Sample Elapsed Time:</Text>
                      <Text style={styles.fieldValue}>
                        {scenarioResult.gps.isUnavailable
                          ? 'null'
                          : safeStr(scenarioResult.gps.elapsedTimeFormatted)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabelBold}>Calculated Velocity:</Text>
                      <Text
                        style={[
                          styles.velocityText,
                          scenarioResult.gps.isImpossibleSpeed
                            ? styles.textDanger
                            : styles.textSuccess,
                        ]}
                      >
                        {scenarioResult.gps.isUnavailable
                          ? 'null (Unavailable)'
                          : `${safeNum(scenarioResult.gps.velocityKmh)} km/h`}
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Expandable Section 2: Session Information */}
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.accordionHeader}
                  onPress={() => setShowSessionDetails(!showSessionDetails)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.accordionTitle}>
                    {showSessionDetails ? '▼' : '▶'} Session & Hardware Telemetry
                  </Text>
                  <Text style={styles.accordionSub}>
                    {scenarioResult.session.isDeviceRecognised ? 'Recognized' : 'Unknown Hardware'}
                  </Text>
                </TouchableOpacity>

                {showSessionDetails && (
                  <View style={styles.accordionBody}>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Session ID:</Text>
                      <Text style={styles.fieldMonospaceBold}>
                        {safeStr(scenarioResult.session.sessionId)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Login Time:</Text>
                      <Text style={styles.fieldMonospace}>
                        {safeStr(scenarioResult.session.loginTime)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Time Window:</Text>
                      <Text style={styles.fieldValue}>
                        {safeStr(scenarioResult.session.timeClassification)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Device Identifier:</Text>
                      <Text
                        style={styles.fieldDeviceId}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {safeStr(scenarioResult.session.deviceId)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Device Status:</Text>
                      <Text
                        style={
                          scenarioResult.session.isDeviceRecognised
                            ? styles.textSuccess
                            : styles.textWarning
                        }
                      >
                        {scenarioResult.session.isDeviceRecognised
                          ? '✓ Known Hardware'
                          : '⚠️ Unrecognized Hardware'}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Session Status:</Text>
                      <Text style={styles.fieldValueBold}>
                        {safeStr(scenarioResult.session.sessionStatus)}
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Expandable Section 3: Network Information */}
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.accordionHeader}
                  onPress={() => setShowNetworkDetails(!showNetworkDetails)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.accordionTitle}>
                    {showNetworkDetails ? '▼' : '▶'} Network Intelligence
                  </Text>
                  <Text style={styles.accordionSub}>
                    {safeStr(scenarioResult.network.networkRiskStatus)}
                  </Text>
                </TouchableOpacity>

                {showNetworkDetails && (
                  <View style={styles.accordionBody}>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Test IP Address:</Text>
                      <Text style={styles.fieldMonospaceHighlight}>
                        {safeStr(scenarioResult.network.testIpLabel)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Connection Type:</Text>
                      <Text style={styles.fieldValue}>
                        {safeStr(scenarioResult.network.connectionType)}
                      </Text>
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Network Status:</Text>
                      <Text style={styles.fieldValueBold}>
                        {safeStr(scenarioResult.network.networkStatus)}
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Expandable Section 4: Collapsible Integration Payload (JSON) */}
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.accordionHeader}
                  onPress={() => setShowJsonPayload(!showJsonPayload)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.accordionTitle}>
                    {showJsonPayload ? '▼' : '▶'} View Integration Payload (JSON)
                  </Text>
                  <Text style={styles.accordionSub}>Pipeline Contract</Text>
                </TouchableOpacity>

                {showJsonPayload && (
                  <View style={styles.accordionBody}>
                    <View style={styles.codeContainer}>
                      <Text style={styles.codeText}>
                        {JSON.stringify(scenarioResult.payload, null, 2)}
                      </Text>
                    </View>

                    <TouchableOpacity
                      style={[
                        styles.dispatchButton,
                        dispatched && styles.dispatchButtonDone,
                      ]}
                      onPress={handleDispatchPayload}
                      activeOpacity={0.8}
                    >
                      <Text style={styles.dispatchButtonText}>
                        {dispatched
                          ? '✓ Dispatched to Stage 1 Pipeline (onStage1Result)'
                          : '📤 Dispatch Payload to Pipeline Callback'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* Action Buttons to Reconfigure or Done */}
              <View style={styles.resultsActions}>
                <TouchableOpacity
                  style={styles.reconfigButton}
                  onPress={() => setScenarioResult(null)}
                  activeOpacity={0.75}
                >
                  <Text style={styles.reconfigButtonText}>✎ Reconfigure Inputs</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.doneButton}
                  onPress={onClose}
                  activeOpacity={0.75}
                >
                  <Text style={styles.doneButtonText}>Done (Back to Dashboard)</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            /* ==================================================
               CONFIGURATION FORM
               ================================================== */
            <View>
              {/* Quick Preset Selector (Part 4) */}
              <View style={styles.presetSection}>
                <Text style={styles.sectionHeading}>Quick Scenarios (Presets)</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.presetScroll}
                >
                  {QUICK_SCENARIO_PRESETS.map((preset) => (
                    <TouchableOpacity
                      key={preset.id}
                      style={styles.presetChip}
                      onPress={() => handleApplyPreset(preset)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.presetChipText}>{preset.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              {/* CATEGORY A: Rider Profile */}
              <View style={styles.configCard}>
                <Text style={styles.configCardTitle}>A. Rider Profile</Text>
                <View style={styles.pillsContainer}>
                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      riderChoice === 'regular' && styles.choicePillActive,
                    ]}
                    onPress={() => setRiderChoice('regular')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        riderChoice === 'regular' && styles.choicePillTextActive,
                      ]}
                    >
                      Regular Rider
                    </Text>
                    <Text style={styles.choicePillSub}>Alex Vance (Verified)</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      riderChoice === 'new_device' && styles.choicePillActive,
                    ]}
                    onPress={() => setRiderChoice('new_device')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        riderChoice === 'new_device' && styles.choicePillTextActive,
                      ]}
                    >
                      New Device Rider
                    </Text>
                    <Text style={styles.choicePillSub}>Elena Rostova</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      riderChoice === 'unusual_pattern' && styles.choicePillActive,
                    ]}
                    onPress={() => setRiderChoice('unusual_pattern')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        riderChoice === 'unusual_pattern' && styles.choicePillTextActive,
                      ]}
                    >
                      Unusual Login Pattern
                    </Text>
                    <Text style={styles.choicePillSub}>Marcus Chen (Flagged)</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* CATEGORY B: GPS Behaviour */}
              <View style={styles.configCard}>
                <Text style={styles.configCardTitle}>B. GPS Behaviour</Text>
                <View style={styles.pillsGrid}>
                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      gpsChoice === 'normal' && styles.choicePillActive,
                    ]}
                    onPress={() => setGpsChoice('normal')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        gpsChoice === 'normal' && styles.choicePillTextActive,
                      ]}
                    >
                      Normal Movement
                    </Text>
                    <Text style={styles.choicePillSub}>1.9 km @ 14 km/h</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      gpsChoice === 'nearby' && styles.choicePillActive,
                    ]}
                    onPress={() => setGpsChoice('nearby')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        gpsChoice === 'nearby' && styles.choicePillTextActive,
                      ]}
                    >
                      Moving Nearby
                    </Text>
                    <Text style={styles.choicePillSub}>0.36 km @ 8 km/h</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      gpsChoice === 'impossible' && styles.choicePillActiveDanger,
                    ]}
                    onPress={() => setGpsChoice('impossible')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        gpsChoice === 'impossible' && styles.choicePillTextActive,
                      ]}
                    >
                      Impossible Travel
                    </Text>
                    <Text style={styles.choicePillSub}>+25 km @ 750 km/h</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      gpsChoice === 'unavailable' && styles.choicePillActiveWarning,
                    ]}
                    onPress={() => setGpsChoice('unavailable')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        gpsChoice === 'unavailable' && styles.choicePillTextActive,
                      ]}
                    >
                      GPS Unavailable
                    </Text>
                    <Text style={styles.choicePillSub}>null coordinates</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* CATEGORY C: Login / Session Behaviour */}
              <View style={styles.configCard}>
                <Text style={styles.configCardTitle}>C. Login / Session Behaviour</Text>
                <View style={styles.pillsGrid}>
                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      sessionChoice === 'normal' && styles.choicePillActive,
                    ]}
                    onPress={() => setSessionChoice('normal')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        sessionChoice === 'normal' && styles.choicePillTextActive,
                      ]}
                    >
                      Normal Login
                    </Text>
                    <Text style={styles.choicePillSub}>Daytime / Known device</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      sessionChoice === 'off_hours' && styles.choicePillActiveWarning,
                    ]}
                    onPress={() => setSessionChoice('off_hours')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        sessionChoice === 'off_hours' && styles.choicePillTextActive,
                      ]}
                    >
                      Off-Hours Login
                    </Text>
                    <Text style={styles.choicePillSub}>03:22 AM Night</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      sessionChoice === 'unknown_device' && styles.choicePillActiveWarning,
                    ]}
                    onPress={() => setSessionChoice('unknown_device')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        sessionChoice === 'unknown_device' && styles.choicePillTextActive,
                      ]}
                    >
                      Unknown Device
                    </Text>
                    <Text style={styles.choicePillSub}>New hardware</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePillSmall,
                      sessionChoice === 'suspicious' && styles.choicePillActiveDanger,
                    ]}
                    onPress={() => setSessionChoice('suspicious')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        sessionChoice === 'suspicious' && styles.choicePillTextActive,
                      ]}
                    >
                      Suspicious Session
                    </Text>
                    <Text style={styles.choicePillSub}>Multi-risk alert</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* CATEGORY D: Network Behaviour */}
              <View style={styles.configCard}>
                <Text style={styles.configCardTitle}>D. Network Behaviour</Text>
                <View style={styles.pillsContainer}>
                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      networkChoice === 'normal_network' && styles.choicePillActive,
                    ]}
                    onPress={() => setNetworkChoice('normal_network')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        networkChoice === 'normal_network' && styles.choicePillTextActive,
                      ]}
                    >
                      Normal Test Network
                    </Text>
                    <Text style={styles.choicePillSub}>198.51.100.15 (Mobile 5G)</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      networkChoice === 'different_ip' && styles.choicePillActiveWarning,
                    ]}
                    onPress={() => setNetworkChoice('different_ip')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        networkChoice === 'different_ip' && styles.choicePillTextActive,
                      ]}
                    >
                      Different Test IP
                    </Text>
                    <Text style={styles.choicePillSub}>203.0.113.54 (Datacenter / VPS)</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.choicePill,
                      networkChoice === 'unavailable' && styles.choicePillActiveDanger,
                    ]}
                    onPress={() => setNetworkChoice('unavailable')}
                    activeOpacity={0.8}
                  >
                    <Text
                      style={[
                        styles.choicePillText,
                        networkChoice === 'unavailable' && styles.choicePillTextActive,
                      ]}
                    >
                      Network Unavailable
                    </Text>
                    <Text style={styles.choicePillSub}>null IP / Offline</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Selected Configuration Summary (Before Execution) */}
              <View style={styles.configSummaryBox}>
                <Text style={styles.configSummaryTitle}>Selected Configuration:</Text>
                <Text style={styles.configSummaryItem}>
                  • <Text style={styles.boldText}>Rider:</Text>{' '}
                  {riderChoice === 'regular'
                    ? 'Regular (Alex Vance)'
                    : riderChoice === 'new_device'
                    ? 'New Device (Elena Rostova)'
                    : 'Unusual Pattern (Marcus Chen)'}
                </Text>
                <Text style={styles.configSummaryItem}>
                  • <Text style={styles.boldText}>GPS:</Text>{' '}
                  {gpsChoice === 'normal'
                    ? 'Normal Movement (~1.9 km @ 14 km/h)'
                    : gpsChoice === 'nearby'
                    ? 'Nearby Hop (~0.36 km)'
                    : gpsChoice === 'impossible'
                    ? 'Impossible Travel (+25 km @ ~750 km/h)'
                    : 'GPS Unavailable (null)'}
                </Text>
                <Text style={styles.configSummaryItem}>
                  • <Text style={styles.boldText}>Session:</Text>{' '}
                  {sessionChoice === 'normal'
                    ? 'Normal Daytime Login'
                    : sessionChoice === 'off_hours'
                    ? 'Off-Hours Night (03:22 AM)'
                    : sessionChoice === 'unknown_device'
                    ? 'Unknown Hardware'
                    : 'Suspicious Session (Off-hours + VM)'}
                </Text>
                <Text style={styles.configSummaryItem}>
                  • <Text style={styles.boldText}>Network:</Text>{' '}
                  {networkChoice === 'normal_network'
                    ? 'Normal Mobile Carrier (198.51.100.15)'
                    : networkChoice === 'different_ip'
                    ? 'Datacenter / Different IP (203.0.113.54)'
                    : 'Offline / Unavailable (null)'}
                </Text>
              </View>

              {/* Primary Action Buttons */}
              <TouchableOpacity
                style={[styles.runButton, isCalculating && styles.runButtonDisabled]}
                onPress={handleRunScenario}
                disabled={isCalculating}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Run Scenario"
              >
                {isCalculating ? (
                  <ActivityIndicator color="#F8FAFC" />
                ) : (
                  <Text style={styles.runButtonText}>🚀 Run Scenario</Text>
                )}
              </TouchableOpacity>

              <View style={styles.bottomButtonsRow}>
                <TouchableOpacity
                  style={styles.clearButton}
                  onPress={handleClearSelection}
                  activeOpacity={0.7}
                >
                  <Text style={styles.clearButtonText}>✕ Clear Selection</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.dashboardButton}
                  onPress={onClose}
                  activeOpacity={0.7}
                >
                  <Text style={styles.dashboardButtonText}>Back to Dashboard</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 14 : 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    backgroundColor: '#1E293B',
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: '#334155',
    borderRadius: 8,
  },
  backButtonText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
  },
  topBarTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  topBarTitle: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
    marginRight: 8,
  },
  simBadge: {
    backgroundColor: '#7C3AED',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  simBadgeText: {
    color: '#F8FAFC',
    fontSize: 9,
    fontWeight: '800',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  presetSection: {
    marginBottom: 12,
  },
  sectionHeading: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  presetScroll: {
    paddingBottom: 4,
  },
  presetChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#475569',
  },
  presetChipText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
  },
  configCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  configCardTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 8,
  },
  pillsContainer: {
    gap: 6,
  },
  pillsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  choicePill: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  choicePillSmall: {
    width: '48.5%',
    backgroundColor: '#0F172A',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  choicePillActive: {
    backgroundColor: '#1E3A8A',
    borderColor: '#3B82F6',
  },
  choicePillActiveWarning: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
  },
  choicePillActiveDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
  },
  choicePillText: {
    color: '#CBD5E1',
    fontSize: 12,
    fontWeight: '700',
  },
  choicePillTextActive: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  choicePillSub: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
  },
  configSummaryBox: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    marginVertical: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  configSummaryTitle: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  configSummaryItem: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 16,
  },
  boldText: {
    color: '#E2E8F0',
    fontWeight: '700',
  },
  runButton: {
    backgroundColor: '#2563EB',
    minHeight: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 3,
  },
  runButtonDisabled: {
    backgroundColor: '#1E3A8A',
    opacity: 0.7,
  },
  runButtonText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  bottomButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  clearButton: {
    flex: 1,
    minHeight: 40,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  clearButtonText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  dashboardButton: {
    flex: 1,
    minHeight: 40,
    backgroundColor: '#334155',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  dashboardButtonText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  resultsContainer: {
    paddingBottom: 20,
  },
  assessmentCard: {
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1.5,
  },
  assessmentSuccess: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  assessmentWarning: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
  },
  assessmentDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
  },
  assessmentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  assessmentHeading: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
  },
  assessmentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pillSuccess: {
    backgroundColor: '#10B981',
  },
  pillWarning: {
    backgroundColor: '#F59E0B',
  },
  pillDanger: {
    backgroundColor: '#DC2626',
  },
  assessmentBadgeText: {
    color: '#0F172A',
    fontSize: 10,
    fontWeight: '800',
  },
  assessmentGuidanceText: {
    color: '#F1F5F9',
    fontSize: 11,
    lineHeight: 16,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#334155',
  },
  cardSectionTitle: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    paddingBottom: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  summaryLabel: {
    color: '#94A3B8',
    fontSize: 12,
  },
  summaryValue: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
  },
  summaryValueBold: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  riskSignalsRow: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  tagWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  flagTag: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#334155',
  },
  flagTagSuccess: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  flagTagWarning: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
  },
  flagTagDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
  },
  flagTagText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '700',
  },
  accordionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  accordionTitle: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
  accordionSub: {
    color: '#94A3B8',
    fontSize: 11,
  },
  accordionBody: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 3,
  },
  fieldLabel: {
    color: '#94A3B8',
    fontSize: 11,
  },
  fieldLabelBold: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '700',
  },
  fieldValue: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '600',
  },
  fieldValueBold: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
  },
  fieldValueText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
    maxWidth: '65%',
    textAlign: 'right',
  },
  fieldValueHighlight: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
  },
  fieldMonospace: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#CBD5E1',
    fontSize: 11,
  },
  fieldMonospaceBold: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
  },
  fieldMonospaceHighlight: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  fieldDeviceId: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#93C5FD',
    fontSize: 10,
    maxWidth: '65%',
  },
  velocityText: {
    fontSize: 12,
    fontWeight: '800',
  },
  textSuccess: {
    color: '#10B981',
  },
  textWarning: {
    color: '#F59E0B',
  },
  textDanger: {
    color: '#EF4444',
  },
  fieldDivider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 4,
  },
  codeContainer: {
    backgroundColor: '#020617',
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginBottom: 8,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 10,
    color: '#A5F3FC',
    lineHeight: 14,
  },
  dispatchButton: {
    minHeight: 40,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  dispatchButtonDone: {
    backgroundColor: '#059669',
  },
  dispatchButtonText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
  },
  resultsActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  reconfigButton: {
    flex: 1,
    minHeight: 42,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#3B82F6',
  },
  reconfigButtonText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '700',
  },
  doneButton: {
    flex: 1,
    minHeight: 42,
    backgroundColor: '#059669',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  doneButtonText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '700',
  },
});
