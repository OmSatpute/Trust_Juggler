import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';

import { getComputedGpsScenario, getGpsScenarios } from './mock/mockLocations.js';
import { getMockRiders, getMockRiderById } from './mock/mockRiders.js';
import { getMockSessionScenario, getSessionScenarios } from './mock/mockSessions.js';
import { getMockNetworkData, getNetworkPresets } from './mock/mockNetwork.js';
import { QUICK_SCENARIO_PRESETS } from './mock/scenarioEngine.js';
import CustomScenarioModal from './CustomScenarioModal.js';

// Safe formatting helpers to prevent NaN or undefined display
const safeStr = (val, fallback = 'N/A') => (val != null && val !== '' ? String(val) : fallback);
const safeNum = (val, fallback = '--') => (val != null && !isNaN(val) ? String(val) : fallback);

/**
 * MockDataLab Component
 * Provides clean, compact 4-module cards, isolated individual inspection,
 * quick scenario presets, and access to the Custom Mock Scenario Builder.
 */
export default function MockDataLab({ onStage1Result }) {
  // Active module card: 'gps' | 'rider' | 'session' | 'network' | null
  const [activeModule, setActiveModule] = useState(null);

  // Modal State for Custom Scenario Builder
  const [showScenarioModal, setShowScenarioModal] = useState(false);
  const [activePresetId, setActivePresetId] = useState(null);

  // Sub-scenario selections for individual modules
  const [selectedGpsId, setSelectedGpsId] = useState('normal_movement');
  const [selectedRiderId, setSelectedRiderId] = useState('RDR-8821');
  const [selectedSessionId, setSelectedSessionId] = useState('normal_login');
  const [selectedNetworkId, setSelectedNetworkId] = useState('cellular_5g');

  // Collapsible JSON payload states for individual modules
  const [showModuleJson, setShowModuleJson] = useState(false);
  const [dispatchedModule, setDispatchedModule] = useState(false);

  // Datasets for sub-pickers
  const allGpsScenarios = getGpsScenarios();
  const allRiders = getMockRiders();
  const allSessionScenarios = getSessionScenarios();
  const allNetworkPresets = getNetworkPresets();

  // Computed views for individual inspection
  const computedGps = getComputedGpsScenario(selectedGpsId);
  const activeRider = getMockRiderById(selectedRiderId);
  const activeSession = getMockSessionScenario(selectedSessionId);
  const activeNetwork = getMockNetworkData(selectedNetworkId);

  // Toggle or select an individual module
  const handleToggleModule = (moduleKey) => {
    setShowModuleJson(false);
    setDispatchedModule(false);
    if (activeModule === moduleKey) {
      setActiveModule(null); // Clicking active module closes it
    } else {
      setActiveModule(moduleKey);
    }
  };

  // Open Scenario Builder directly or preloaded with preset
  const handleOpenScenarioBuilder = (presetId = null) => {
    setActivePresetId(presetId);
    setShowScenarioModal(true);
  };

  // Dispatch individual module payload if desired
  const handleDispatchModulePayload = (payload) => {
    if (typeof onStage1Result === 'function' && payload) {
      onStage1Result(payload);
      setDispatchedModule(true);
    }
  };

  return (
    <View style={styles.container}>
      {/* ==================================================
          1. COMPACT SCENARIO BUILDER CALLOUT & PRESETS
         ================================================== */}
      <View style={styles.topActionsCard}>
        {/* Primary Callout: Build Custom Mock Scenario */}
        <TouchableOpacity
          style={styles.builderButton}
          onPress={() => handleOpenScenarioBuilder(null)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Build Custom Mock Scenario"
        >
          <Text style={styles.builderIcon}>🛠️</Text>
          <View style={styles.builderContent}>
            <Text style={styles.builderTitle}>Build Custom Mock Scenario</Text>
            <Text style={styles.builderSub}>
              Combine Rider, GPS, Session & Network inputs
            </Text>
          </View>
          <Text style={styles.builderArrow}>→</Text>
        </TouchableOpacity>

        {/* Quick Presets Bar (Part 4) */}
        <View style={styles.presetsBar}>
          <Text style={styles.presetsHeading}>Quick Scenarios:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.presetsScroll}
          >
            {QUICK_SCENARIO_PRESETS.map((preset) => (
              <TouchableOpacity
                key={preset.id}
                style={styles.presetChip}
                onPress={() => handleOpenScenarioBuilder(preset.id)}
                activeOpacity={0.75}
              >
                <Text style={styles.presetChipText}>{preset.name}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>

      {/* ==================================================
          2. FOUR COMPACT MODULE CARDS (PART 1 & PART 5)
         ================================================== */}
      <Text style={styles.sectionTitle}>Individual Mock Modules</Text>
      <View style={styles.modulesGrid}>
        {/* Module 1: Mock GPS */}
        <TouchableOpacity
          style={[
            styles.moduleCard,
            activeModule === 'gps' && styles.moduleCardActiveGps,
          ]}
          onPress={() => handleToggleModule('gps')}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Mock GPS Module"
        >
          <View style={styles.moduleHeaderRow}>
            <Text style={styles.moduleIcon}>📍</Text>
            <View
              style={[
                styles.moduleBadge,
                activeModule === 'gps' && styles.moduleBadgeActive,
              ]}
            >
              <Text style={styles.moduleBadgeText}>
                {activeModule === 'gps' ? 'OPEN' : 'GPS'}
              </Text>
            </View>
          </View>
          <Text style={styles.moduleTitle}>Mock GPS</Text>
          <Text style={styles.moduleSubtitle}>Haversine & Velocity</Text>
        </TouchableOpacity>

        {/* Module 2: Mock Rider Data */}
        <TouchableOpacity
          style={[
            styles.moduleCard,
            activeModule === 'rider' && styles.moduleCardActiveRider,
          ]}
          onPress={() => handleToggleModule('rider')}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Mock Rider Data Module"
        >
          <View style={styles.moduleHeaderRow}>
            <Text style={styles.moduleIcon}>👤</Text>
            <View
              style={[
                styles.moduleBadge,
                activeModule === 'rider' && styles.moduleBadgeActive,
              ]}
            >
              <Text style={styles.moduleBadgeText}>
                {activeModule === 'rider' ? 'OPEN' : 'RIDER'}
              </Text>
            </View>
          </View>
          <Text style={styles.moduleTitle}>Mock Rider Data</Text>
          <Text style={styles.moduleSubtitle}>Fictional Profiles</Text>
        </TouchableOpacity>

        {/* Module 3: Mock Login / Session */}
        <TouchableOpacity
          style={[
            styles.moduleCard,
            activeModule === 'session' && styles.moduleCardActiveSession,
          ]}
          onPress={() => handleToggleModule('session')}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Mock Login and Session Module"
        >
          <View style={styles.moduleHeaderRow}>
            <Text style={styles.moduleIcon}>⏱️</Text>
            <View
              style={[
                styles.moduleBadge,
                activeModule === 'session' && styles.moduleBadgeActive,
              ]}
            >
              <Text style={styles.moduleBadgeText}>
                {activeModule === 'session' ? 'OPEN' : 'SESSION'}
              </Text>
            </View>
          </View>
          <Text style={styles.moduleTitle}>Mock Login / Session</Text>
          <Text style={styles.moduleSubtitle}>Shift & Device Gate</Text>
        </TouchableOpacity>

        {/* Module 4: Mock Network Data */}
        <TouchableOpacity
          style={[
            styles.moduleCard,
            activeModule === 'network' && styles.moduleCardActiveNetwork,
          ]}
          onPress={() => handleToggleModule('network')}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Mock Network Data Module"
        >
          <View style={styles.moduleHeaderRow}>
            <Text style={styles.moduleIcon}>🌐</Text>
            <View
              style={[
                styles.moduleBadge,
                activeModule === 'network' && styles.moduleBadgeActive,
              ]}
            >
              <Text style={styles.moduleBadgeText}>
                {activeModule === 'network' ? 'OPEN' : 'NETWORK'}
              </Text>
            </View>
          </View>
          <Text style={styles.moduleTitle}>Mock Network Data</Text>
          <Text style={styles.moduleSubtitle}>RFC 5737 Test IPs</Text>
        </TouchableOpacity>
      </View>

      {/* ==================================================
          3. DEDICATED RESULTS SECTION (SHOWS ONLY SELECTED MODULE)
         ================================================== */}

      {/* Empty State when no module is open */}
      {activeModule == null && (
        <View style={styles.emptyPromptCard}>
          <Text style={styles.emptyPromptIcon}>🔍</Text>
          <Text style={styles.emptyPromptTitle}>No Module Expanded</Text>
          <Text style={styles.emptyPromptSubtitle}>
            Tap any module card above to inspect isolated telemetry, or tap "Build Custom Mock Scenario" to combine multiple inputs.
          </Text>
        </View>
      )}

      {/* --------------------------------------------------
          A. MOCK GPS RESULTS (GPS ONLY)
         -------------------------------------------------- */}
      {activeModule === 'gps' && computedGps && (
        <View style={styles.moduleDetailCard}>
          <View style={styles.detailHeader}>
            <View style={styles.detailHeaderLeft}>
              <Text style={styles.detailIcon}>📍</Text>
              <Text style={styles.detailTitle}>Mock GPS Telemetry</Text>
            </View>
            <TouchableOpacity
              style={styles.closeModuleButton}
              onPress={() => setActiveModule(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.closeModuleButtonText}>✕ Close</Text>
            </TouchableOpacity>
          </View>

          {/* Sub-scenario selector chips */}
          <Text style={styles.selectorLabel}>Select GPS Scenario:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsScroll}
          >
            {allGpsScenarios.map((scen) => {
              const isSelected = scen.id === selectedGpsId;
              return (
                <TouchableOpacity
                  key={scen.id}
                  style={[styles.chip, isSelected && styles.chipActive]}
                  onPress={() => setSelectedGpsId(scen.id)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.chipText, isSelected && styles.chipTextActive]}
                  >
                    {scen.title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Assessment Banner */}
          <View
            style={[
              styles.assessmentBanner,
              computedGps.isSuspicious
                ? styles.bannerDanger
                : computedGps.isUnavailable
                ? styles.bannerWarning
                : styles.bannerSuccess,
            ]}
          >
            <Text
              style={[
                styles.assessmentText,
                computedGps.isSuspicious
                  ? styles.textDanger
                  : computedGps.isUnavailable
                  ? styles.textWarning
                  : styles.textSuccess,
              ]}
            >
              {computedGps.movementAssessment}
            </Text>
          </View>

          {/* Compact Telemetry Metrics */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Rider ID:</Text>
            <Text style={styles.fieldValueBold}>{safeStr(computedGps.riderId)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Current Coordinates:</Text>
            <Text style={styles.fieldMonospace}>
              {computedGps.isUnavailable
                ? 'null (Unavailable)'
                : `${safeStr(computedGps.currentCoordinatesFormatted)} [SIMULATED]`}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Current Location:</Text>
            <Text style={styles.fieldValueText}>
              {safeStr(computedGps.currentLocationName)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Previous Location:</Text>
            <Text style={styles.fieldValueText}>
              {safeStr(computedGps.previousLocationName)}
            </Text>
          </View>

          <View style={styles.fieldDivider} />

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Distance Travelled:</Text>
            <Text style={styles.fieldValueHighlight}>
              {computedGps.isUnavailable
                ? 'null'
                : `${safeNum(computedGps.distanceKm)} km (Haversine)`}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Time Elapsed:</Text>
            <Text style={styles.fieldValue}>
              {computedGps.isUnavailable ? 'null' : safeStr(computedGps.elapsedTimeFormatted)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabelBold}>Calculated Velocity:</Text>
            <Text
              style={[
                styles.velocityValue,
                computedGps.isSuspicious ? styles.textDanger : styles.textSuccess,
              ]}
            >
              {computedGps.isUnavailable
                ? 'null'
                : `${safeNum(computedGps.velocityKmh)} km/h (Limit: 120 km/h)`}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>GPS Status:</Text>
            <Text style={styles.statusPillOk}>{safeStr(computedGps.gpsStatus)}</Text>
          </View>

          {/* Collapsible Integration Payload (Part 1 #5) */}
          <TouchableOpacity
            style={styles.collapsibleButton}
            onPress={() => setShowModuleJson(!showModuleJson)}
            activeOpacity={0.7}
          >
            <Text style={styles.collapsibleButtonText}>
              {showModuleJson ? '▼ Hide Integration Payload' : '▶ View Integration Payload (JSON)'}
            </Text>
          </TouchableOpacity>

          {showModuleJson && (
            <View style={styles.jsonContainer}>
              <Text style={styles.jsonText}>
                {JSON.stringify(
                  {
                    simulated: true,
                    rider_id: computedGps.riderId,
                    lat: computedGps.currentLat,
                    lon: computedGps.currentLon,
                    distance_km: computedGps.distanceKm,
                    velocity_kmh: computedGps.velocityKmh,
                    elapsed_seconds: computedGps.elapsedSeconds,
                    gps_status: computedGps.gpsStatus,
                    movement_status: computedGps.movementStatus,
                  },
                  null,
                  2
                )}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* --------------------------------------------------
          B. MOCK RIDER DATA RESULTS (RIDER ONLY)
         -------------------------------------------------- */}
      {activeModule === 'rider' && activeRider && (
        <View style={styles.moduleDetailCard}>
          <View style={styles.detailHeader}>
            <View style={styles.detailHeaderLeft}>
              <Text style={styles.detailIcon}>👤</Text>
              <Text style={styles.detailTitle}>Mock Rider Profile</Text>
            </View>
            <TouchableOpacity
              style={styles.closeModuleButton}
              onPress={() => setActiveModule(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.closeModuleButtonText}>✕ Close</Text>
            </TouchableOpacity>
          </View>

          {/* Profile Switcher Chips */}
          <Text style={styles.selectorLabel}>Select Fictional Profile:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsScroll}
          >
            {allRiders.map((r) => {
              const isSelected = r.riderId === selectedRiderId;
              return (
                <TouchableOpacity
                  key={r.riderId}
                  style={[styles.chip, isSelected && styles.chipActive]}
                  onPress={() => setSelectedRiderId(r.riderId)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.chipText, isSelected && styles.chipTextActive]}
                  >
                    {r.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Rider Fields */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Rider ID:</Text>
            <Text style={styles.fieldMonospaceBold}>{safeStr(activeRider.riderId)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Courier Name:</Text>
            <Text style={styles.fieldValueBold}>{safeStr(activeRider.name)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Phone (Fictional):</Text>
            <Text style={styles.fieldMonospace}>{safeStr(activeRider.phoneNumber)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Registered Device:</Text>
            <Text style={styles.fieldDeviceId} numberOfLines={1} ellipsizeMode="middle">
              {safeStr(activeRider.registeredDeviceId)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Working Zone:</Text>
            <Text style={styles.fieldValueText}>{safeStr(activeRider.usualWorkingLocation)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Usual Hours:</Text>
            <Text style={styles.fieldValue}>{safeStr(activeRider.usualLoginHours)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Account Status:</Text>
            <Text
              style={[
                styles.statusBadge,
                activeRider.accountStatus === 'VERIFIED_ACTIVE'
                  ? styles.badgeSuccess
                  : styles.badgeWarning,
              ]}
            >
              {safeStr(activeRider.accountStatus)}
            </Text>
          </View>

          <View style={styles.fieldDivider} />

          <Text style={styles.subHeading}>Known Devices ({activeRider.knownDevices?.length || 0}):</Text>
          {activeRider.knownDevices?.map((dev, idx) => (
            <View key={idx} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{dev}</Text>
            </View>
          ))}

          {/* Collapsible Integration Payload */}
          <TouchableOpacity
            style={styles.collapsibleButton}
            onPress={() => setShowModuleJson(!showModuleJson)}
            activeOpacity={0.7}
          >
            <Text style={styles.collapsibleButtonText}>
              {showModuleJson ? '▼ Hide Integration Payload' : '▶ View Integration Payload (JSON)'}
            </Text>
          </TouchableOpacity>

          {showModuleJson && (
            <View style={styles.jsonContainer}>
              <Text style={styles.jsonText}>
                {JSON.stringify(activeRider, null, 2)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* --------------------------------------------------
          C. MOCK LOGIN / SESSION RESULTS (SESSION ONLY)
         -------------------------------------------------- */}
      {activeModule === 'session' && activeSession && (
        <View style={styles.moduleDetailCard}>
          <View style={styles.detailHeader}>
            <View style={styles.detailHeaderLeft}>
              <Text style={styles.detailIcon}>⏱️</Text>
              <Text style={styles.detailTitle}>Mock Login / Session Data</Text>
            </View>
            <TouchableOpacity
              style={styles.closeModuleButton}
              onPress={() => setActiveModule(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.closeModuleButtonText}>✕ Close</Text>
            </TouchableOpacity>
          </View>

          {/* Scenario Selector Chips */}
          <Text style={styles.selectorLabel}>Select Session Scenario:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsScroll}
          >
            {allSessionScenarios.map((sess) => {
              const isSelected = sess.id === selectedSessionId;
              return (
                <TouchableOpacity
                  key={sess.id}
                  style={[styles.chip, isSelected && styles.chipActive]}
                  onPress={() => setSelectedSessionId(sess.id)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.chipText, isSelected && styles.chipTextActive]}
                  >
                    {sess.title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Session Risk Banner */}
          <View
            style={[
              styles.assessmentBanner,
              activeSession.riskLevel === 'CRITICAL'
                ? styles.bannerDanger
                : activeSession.riskLevel === 'MEDIUM'
                ? styles.bannerWarning
                : styles.bannerSuccess,
            ]}
          >
            <Text
              style={[
                styles.assessmentText,
                activeSession.riskLevel === 'CRITICAL'
                  ? styles.textDanger
                  : activeSession.riskLevel === 'MEDIUM'
                  ? styles.textWarning
                  : styles.textSuccess,
              ]}
            >
              Risk: {activeSession.riskLevel} — {activeSession.details}
            </Text>
          </View>

          {/* Session Fields */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Session ID:</Text>
            <Text style={styles.fieldMonospaceBold}>{safeStr(activeSession.sessionId)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Login Timestamp:</Text>
            <Text style={styles.fieldMonospace}>{safeStr(activeSession.loginTimestamp)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Login Location:</Text>
            <Text style={styles.fieldValueText}>{safeStr(activeSession.loginLocation)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Device ID:</Text>
            <Text style={styles.fieldDeviceId} numberOfLines={1} ellipsizeMode="middle">
              {safeStr(activeSession.deviceId)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Test IP Address:</Text>
            <Text style={styles.fieldMonospaceHighlight}>{safeStr(activeSession.ipLabel)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Shift Window Status:</Text>
            <Text
              style={
                activeSession.loginTimeClassification.includes('OFF_HOURS')
                  ? styles.textWarning
                  : styles.textSuccess
              }
            >
              {safeStr(activeSession.loginTimeClassification)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Device Recognized:</Text>
            <Text
              style={
                activeSession.isDeviceRecognised
                  ? styles.textSuccess
                  : styles.textWarning
              }
            >
              {activeSession.isDeviceRecognised ? '✓ Known Device' : '⚠️ Unknown Hardware'}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Session Status:</Text>
            <Text style={styles.fieldValueBold}>{safeStr(activeSession.sessionStatus)}</Text>
          </View>

          {/* Collapsible Integration Payload */}
          <TouchableOpacity
            style={styles.collapsibleButton}
            onPress={() => setShowModuleJson(!showModuleJson)}
            activeOpacity={0.7}
          >
            <Text style={styles.collapsibleButtonText}>
              {showModuleJson ? '▼ Hide Integration Payload' : '▶ View Integration Payload (JSON)'}
            </Text>
          </TouchableOpacity>

          {showModuleJson && (
            <View style={styles.jsonContainer}>
              <Text style={styles.jsonText}>
                {JSON.stringify(activeSession, null, 2)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* --------------------------------------------------
          D. MOCK NETWORK DATA RESULTS (NETWORK ONLY)
         -------------------------------------------------- */}
      {activeModule === 'network' && activeNetwork && (
        <View style={styles.moduleDetailCard}>
          <View style={styles.detailHeader}>
            <View style={styles.detailHeaderLeft}>
              <Text style={styles.detailIcon}>🌐</Text>
              <Text style={styles.detailTitle}>Mock Network Telemetry</Text>
            </View>
            <TouchableOpacity
              style={styles.closeModuleButton}
              onPress={() => setActiveModule(null)}
              activeOpacity={0.7}
            >
              <Text style={styles.closeModuleButtonText}>✕ Close</Text>
            </TouchableOpacity>
          </View>

          {/* Network Preset Chips */}
          <Text style={styles.selectorLabel}>Select Test Network Preset:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsScroll}
          >
            {allNetworkPresets.map((preset) => {
              const isSelected = preset.id === selectedNetworkId;
              return (
                <TouchableOpacity
                  key={preset.id}
                  style={[styles.chip, isSelected && styles.chipActive]}
                  onPress={() => setSelectedNetworkId(preset.id)}
                  activeOpacity={0.8}
                >
                  <Text
                    style={[styles.chipText, isSelected && styles.chipTextActive]}
                  >
                    {preset.title}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Network Banner */}
          <View
            style={[
              styles.assessmentBanner,
              activeNetwork.networkRiskStatus.includes('HIGH')
                ? styles.bannerDanger
                : activeNetwork.networkRiskStatus.includes('ELEVATED') ||
                  activeNetwork.networkRiskStatus.includes('MODERATE')
                ? styles.bannerWarning
                : styles.bannerSuccess,
            ]}
          >
            <Text
              style={[
                styles.assessmentText,
                activeNetwork.networkRiskStatus.includes('HIGH')
                  ? styles.textDanger
                  : activeNetwork.networkRiskStatus.includes('ELEVATED') ||
                    activeNetwork.networkRiskStatus.includes('MODERATE')
                  ? styles.textWarning
                  : styles.textSuccess,
              ]}
            >
              {safeStr(activeNetwork.notes)}
            </Text>
          </View>

          {/* Network Fields */}
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Test IP Address:</Text>
            <Text style={styles.fieldMonospaceHighlight}>
              {safeStr(activeNetwork.testIpLabel)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Connection Type:</Text>
            <Text style={styles.fieldValueBold}>{safeStr(activeNetwork.connectionType)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Network Status:</Text>
            <Text style={styles.fieldValue}>{safeStr(activeNetwork.networkStatus)}</Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Risk Classification:</Text>
            <Text
              style={[
                styles.statusBadge,
                activeNetwork.networkRiskStatus.includes('HIGH')
                  ? styles.badgeDanger
                  : activeNetwork.networkRiskStatus.includes('ELEVATED') ||
                    activeNetwork.networkRiskStatus.includes('MODERATE')
                  ? styles.badgeWarning
                  : styles.badgeSuccess,
              ]}
            >
              {safeStr(activeNetwork.networkRiskStatus)}
            </Text>
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Simulated ASN:</Text>
            <Text style={styles.fieldValue}>{safeStr(activeNetwork.asnInfo)}</Text>
          </View>

          {/* Collapsible Integration Payload */}
          <TouchableOpacity
            style={styles.collapsibleButton}
            onPress={() => setShowModuleJson(!showModuleJson)}
            activeOpacity={0.7}
          >
            <Text style={styles.collapsibleButtonText}>
              {showModuleJson ? '▼ Hide Integration Payload' : '▶ View Integration Payload (JSON)'}
            </Text>
          </TouchableOpacity>

          {showModuleJson && (
            <View style={styles.jsonContainer}>
              <Text style={styles.jsonText}>
                {JSON.stringify(activeNetwork, null, 2)}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* ==================================================
          CUSTOM SCENARIO BUILDER MODAL (PART 2 & 3)
         ================================================== */}
      <CustomScenarioModal
        visible={showScenarioModal}
        onClose={() => setShowScenarioModal(false)}
        onStage1Result={onStage1Result}
        initialPresetId={activePresetId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    marginBottom: 20,
  },
  topActionsCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  builderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2563EB',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 3,
  },
  builderIcon: {
    fontSize: 20,
    marginRight: 10,
  },
  builderContent: {
    flex: 1,
  },
  builderTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  builderSub: {
    color: '#BFDBFE',
    fontSize: 11,
    marginTop: 1,
  },
  builderArrow: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '800',
    marginLeft: 6,
  },
  presetsBar: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  presetsHeading: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  presetsScroll: {
    paddingBottom: 2,
  },
  presetChip: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#475569',
  },
  presetChipText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
  },
  sectionTitle: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
    paddingHorizontal: 2,
  },
  modulesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  moduleCard: {
    width: '48.5%',
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#334155',
    minHeight: 76,
    justifyContent: 'space-between',
  },
  moduleCardActiveGps: {
    borderColor: '#3B82F6',
    backgroundColor: '#1E3A8A',
  },
  moduleCardActiveRider: {
    borderColor: '#10B981',
    backgroundColor: '#064E3B',
  },
  moduleCardActiveSession: {
    borderColor: '#8B5CF6',
    backgroundColor: '#4C1D95',
  },
  moduleCardActiveNetwork: {
    borderColor: '#06B6D4',
    backgroundColor: '#164E63',
  },
  moduleHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  moduleIcon: {
    fontSize: 16,
  },
  moduleBadge: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#334155',
  },
  moduleBadgeActive: {
    backgroundColor: '#3B82F6',
    borderColor: '#60A5FA',
  },
  moduleBadgeText: {
    color: '#CBD5E1',
    fontSize: 9,
    fontWeight: '800',
  },
  moduleTitle: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
  },
  moduleSubtitle: {
    color: '#94A3B8',
    fontSize: 10,
    marginTop: 1,
  },
  emptyPromptCard: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#334155',
    borderStyle: 'dashed',
  },
  emptyPromptIcon: {
    fontSize: 22,
    marginBottom: 6,
  },
  emptyPromptTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptyPromptSubtitle: {
    color: '#94A3B8',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  moduleDetailCard: {
    backgroundColor: '#1E293B',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1.5,
    borderColor: '#3B82F6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 3,
  },
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    marginBottom: 8,
  },
  detailHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  detailTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
  },
  closeModuleButton: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: '#334155',
    borderRadius: 6,
  },
  closeModuleButtonText: {
    color: '#CBD5E1',
    fontSize: 10,
    fontWeight: '700',
  },
  selectorLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  chipsScroll: {
    paddingBottom: 8,
  },
  chip: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    marginRight: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  chipActive: {
    backgroundColor: '#3B82F6',
    borderColor: '#60A5FA',
  },
  chipText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#F8FAFC',
    fontWeight: '800',
  },
  assessmentBanner: {
    padding: 10,
    borderRadius: 8,
    marginVertical: 8,
    borderWidth: 1,
  },
  bannerSuccess: {
    backgroundColor: '#064E3B',
    borderColor: '#10B981',
  },
  bannerWarning: {
    backgroundColor: '#78350F',
    borderColor: '#F59E0B',
  },
  bannerDanger: {
    backgroundColor: '#7F1D1D',
    borderColor: '#EF4444',
  },
  assessmentText: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 15,
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
    fontSize: 11,
    fontWeight: '700',
  },
  fieldMonospace: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#CBD5E1',
    fontSize: 10,
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
  velocityValue: {
    fontSize: 12,
    fontWeight: '800',
  },
  statusPillOk: {
    backgroundColor: '#0F172A',
    color: '#38BDF8',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    fontSize: 9,
    fontWeight: '700',
    borderWidth: 1,
    borderColor: '#334155',
    overflow: 'hidden',
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 10,
    fontWeight: '700',
    overflow: 'hidden',
  },
  badgeSuccess: {
    backgroundColor: '#064E3B',
    color: '#34D399',
  },
  badgeWarning: {
    backgroundColor: '#78350F',
    color: '#FBBF24',
  },
  badgeDanger: {
    backgroundColor: '#7F1D1D',
    color: '#F87171',
  },
  fieldDivider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 4,
  },
  subHeading: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
    paddingLeft: 4,
  },
  bulletDot: {
    color: '#3B82F6',
    marginRight: 4,
    fontSize: 12,
  },
  bulletText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#94A3B8',
    fontSize: 10,
  },
  collapsibleButton: {
    marginTop: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  collapsibleButtonText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  jsonContainer: {
    backgroundColor: '#020617',
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginTop: 6,
  },
  jsonText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: '#A5F3FC',
    fontSize: 10,
    lineHeight: 14,
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
});
