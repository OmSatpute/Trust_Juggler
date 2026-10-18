import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraView as CameraViewType } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';

type Partner = { id: string; name: string; vehicle: string; role?: string; enrolled: boolean };
type Order = { id: string; customer?: string; items: string; partner_id: string; state?: string };
type Scan = { kind: 'enroll'; partner: Partner } | { kind: 'verify'; order: Order };
type ScanOutcome = { status: string; result?: string; similarity?: number; threshold?: number; reason?: string; partner_name?: string; assigned_partner_name?: string; model_version?: string };

const PICKUP_API_URL = (process.env.EXPO_PUBLIC_PICKUP_API_URL ?? '').replace(/\/$/, '');

export function RestaurantPage({ active }: { active: boolean }) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [outcomes, setOutcomes] = useState<Record<string, ScanOutcome>>({});
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanning, setScanning] = useState(false);
  const camera = useRef<CameraViewType>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const refresh = useCallback(async () => {
    if (!PICKUP_API_URL) {
      setNotice('Set EXPO_PUBLIC_PICKUP_API_URL in mobile/.env to the pickup API on port 8001.');
      return;
    }
    setLoading(true);
    try {
      const [partnerResponse, orderResponse] = await Promise.all([
        fetch(`${PICKUP_API_URL}/api/partners`), fetch(`${PICKUP_API_URL}/api/orders`),
      ]);
      const partnerData = await partnerResponse.json();
      const orderData = await orderResponse.json();
      if (!partnerResponse.ok) throw new Error(partnerData.detail ?? `Partner API returned ${partnerResponse.status}`);
      if (!orderResponse.ok) throw new Error(orderData.detail ?? `Order API returned ${orderResponse.status}`);
      setPartners(partnerData.partners ?? []);
      setOrders(orderData.orders ?? []);
      setNotice('');
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Network request failed.';
      setNotice(`Could not load restaurant data from ${PICKUP_API_URL}. Confirm the pickup API is running on port 8001 and this phone can reach the computer over Wi-Fi. ${reason}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
    else setScan(null);
  }, [active, refresh]);

  const beginScan = async (action: Scan) => {
    if (!PICKUP_API_URL) {
      setNotice('Set EXPO_PUBLIC_PICKUP_API_URL in mobile/.env to the pickup API on port 8001.');
      return;
    }
    if (!permission?.granted) {
      const nextPermission = await requestPermission();
      if (!nextPermission.granted) {
        setNotice('Camera access is required to enroll or verify a partner.');
        return;
      }
    }
    setNotice('');
    setScan(action);
  };

  const capture = async () => {
    if (!scan || !camera.current || scanning) return;
    setScanning(true);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.6, shutterSound: false });
      if (!photo?.uri) throw new Error('Camera did not return an image. Try again.');
      const endpoint = scan.kind === 'enroll'
        ? `${PICKUP_API_URL}/api/partners/${encodeURIComponent(scan.partner.id)}/enrollment`
        : `${PICKUP_API_URL}/api/orders/${encodeURIComponent(scan.order.id)}/verify`;
      const response = await FileSystem.uploadAsync(endpoint, photo.uri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'image',
        mimeType: 'image/jpeg',
      });
      let data: ScanOutcome & { detail?: string } = { status: '' };
      try { data = JSON.parse(response.body || '{}'); } catch { /* Report the HTTP status below. */ }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(data.detail ?? `Pickup API returned ${response.status}`);
      }

      const result = data.result ?? data.status;
      const key = scan.kind === 'enroll' ? `partner:${scan.partner.id}` : `order:${scan.order.id}`;
      const friendly = result === 'enrolled' ? 'Face baseline enrolled.'
        : result === 'match' ? 'Assigned partner matched.'
          : result === 'mismatch' ? 'Mismatch. Pause pickup and request staff review.'
            : result === 'no_face' ? 'No face detected. Improve lighting and center one face.'
              : result === 'multiple_faces' ? 'More than one face detected. Keep only the assigned partner in frame.'
                : data.reason ?? `Face check returned: ${result}`;
      setOutcomes((current) => ({ ...current, [key]: { ...data, status: friendly } }));
      setScan(null);
      if (result === 'enrolled') await refresh();
      setNotice(result === 'match' || result === 'enrolled' ? '' : friendly);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Face verification could not complete.');
    } finally {
      setScanning(false);
    }
  };

  const closeCamera = () => setScan(null);
  const partnerFor = (id: string) => partners.find((partner) => partner.id === id);

  return (
    <View style={styles.safe}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.headingRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eyebrow}>PICKUP COUNTER  /  IDENTITY CHECK</Text>
            <Text style={styles.title}>Restaurant verification</Text>
          </View>
          <Pressable onPress={() => void refresh()} style={styles.refreshButton} disabled={loading}>
            {loading ? <ActivityIndicator color="#38BDF8" size="small" /> : <Text style={styles.refreshText}>Refresh</Text>}
          </Pressable>
        </View>
        <Text style={styles.intro}>Enroll consenting delivery partners, then compare each arriving rider only with the partner assigned to the selected order.</Text>

        {!PICKUP_API_URL && <Text style={styles.notice}>Configure EXPO_PUBLIC_PICKUP_API_URL in mobile/.env. Use the computer's LAN IP and port 8001.</Text>}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <View style={styles.summaryRow}>
          <Summary label="PARTNERS" value={String(partners.length)} />
          <Summary label="ENROLLED" value={String(partners.filter((partner) => partner.enrolled).length)} />
          <Summary label="READY ORDERS" value={String(orders.length)} />
        </View>

        <Text style={styles.sectionTitle}>1  /  PARTNER ENROLLMENT</Text>
        {partners.map((partner) => {
          const outcome = outcomes[`partner:${partner.id}`];
          return (
            <View key={partner.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.avatar}><Text style={styles.avatarText}>{partner.name.slice(0, 1).toUpperCase()}</Text></View>
                <View style={styles.cardCopy}><Text style={styles.cardTitle}>{partner.name}</Text><Text style={styles.subtle}>{partner.vehicle}</Text></View>
                <Badge label={partner.enrolled ? 'ENROLLED' : 'NEEDS SETUP'} good={partner.enrolled} />
              </View>
              {outcome && <Text style={styles.outcome}>{outcome.status}{outcome.model_version ? ` · ${outcome.model_version}` : ''}</Text>}
              <Button onPress={() => void beginScan({ kind: 'enroll', partner })}>{partner.enrolled ? 'Update face baseline' : 'Enroll face'}</Button>
            </View>
          );
        })}

        <Text style={styles.sectionTitle}>2  /  ORDER PICKUP CHECK</Text>
        {orders.map((order) => {
          const partner = partnerFor(order.partner_id);
          const outcome = outcomes[`order:${order.id}`];
          return (
            <View key={order.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.orderIcon}><Text style={styles.orderIconText}>↗</Text></View>
                <View style={styles.cardCopy}><Text style={styles.cardTitle}>{order.id}</Text><Text style={styles.subtle}>{order.customer ?? 'Pickup order'} · {order.items}</Text></View>
                <Badge label={order.state?.toUpperCase() ?? 'READY'} good />
              </View>
              <View style={styles.assignment}><Text style={styles.label}>ASSIGNED PARTNER</Text><Text style={styles.assignmentName}>{partner?.name ?? order.partner_id}</Text></View>
              {outcome && <View style={[styles.resultBox, outcome.result === 'match' ? styles.resultGood : outcome.result === 'mismatch' ? styles.resultRisk : styles.resultNeutral]}>
                <Text style={styles.resultTitle}>{outcome.status}</Text>
                {outcome.similarity != null && <Text style={styles.subtle}>Similarity {outcome.similarity.toFixed(3)} · threshold {outcome.threshold?.toFixed(2) ?? '—'} · score is not a probability</Text>}
                {outcome.reason && <Text style={styles.subtle}>{outcome.reason}</Text>}
              </View>}
              {!partner?.enrolled && <Text style={styles.helper}>Enroll this assigned partner before verifying the pickup.</Text>}
              <Button disabled={!partner?.enrolled} onPress={() => void beginScan({ kind: 'verify', order })}>Verify assigned rider</Button>
            </View>
          );
        })}

        {!loading && !partners.length && !orders.length && <View style={styles.card}><Text style={styles.subtle}>No partners or orders loaded. Check that the pickup API is running on port 8001.</Text></View>}
        <View style={styles.footer}><Text style={styles.footerTitle}>COUNTER GUIDANCE</Text><Text style={styles.subtle}>A mismatch, uncertain capture, or multiple people should pause pickup for staff review. Face similarity is a demo signal, not proof of identity or liveness.</Text></View>
      </ScrollView>

      <Modal visible={Boolean(scan) && active} animationType="slide" onRequestClose={closeCamera}>
        <View style={styles.cameraScreen}>
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="front" />
          <View style={styles.cameraOverlay}>
            <View style={styles.cameraTop}>
              <View><Text style={styles.cameraEyebrow}>{scan?.kind === 'enroll' ? 'PARTNER ENROLLMENT' : 'ORDER PICKUP CHECK'}</Text><Text style={styles.cameraTitle}>{scan?.kind === 'enroll' ? scan.partner.name : scan?.order.id}</Text></View>
              <Pressable onPress={closeCamera} style={styles.closeButton}><Text style={styles.closeText}>Close</Text></Pressable>
            </View>
            <View style={styles.faceGuide}><View style={styles.faceGuideInner} /></View>
            <View style={styles.cameraBottom}>
              <Text style={styles.cameraHint}>Use a clear, well-lit view with exactly one face in frame.</Text>
              <Pressable disabled={scanning} onPress={() => void capture()} style={[styles.captureButton, scanning && styles.disabled]}>
                {scanning ? <ActivityIndicator color="#07111F" /> : <Text style={styles.captureText}>Capture and check</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <View style={styles.summaryCard}><Text style={styles.summaryValue}>{value}</Text><Text style={styles.summaryLabel}>{label}</Text></View>;
}

function Badge({ label, good }: { label: string; good: boolean }) {
  return <View style={[styles.badge, good ? styles.badgeGood : styles.badgePending]}><Text style={[styles.badgeText, good ? styles.badgeTextGood : styles.badgeTextPending]}>{label}</Text></View>;
}

function Button({ children, onPress, disabled }: { children: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}><Text style={styles.buttonText}>{children}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0F172A' },
  page: { padding: 16, paddingBottom: 30, gap: 11 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  eyebrow: { color: '#38BDF8', fontSize: 8, fontWeight: '900', letterSpacing: 1.3 },
  title: { color: '#F8FAFC', fontSize: 22, fontWeight: '900', marginTop: 4 },
  intro: { color: '#94A3B8', fontSize: 11, lineHeight: 17 },
  refreshButton: { minWidth: 72, minHeight: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111C2E', borderWidth: 1, borderColor: '#334155', borderRadius: 9, paddingHorizontal: 10 },
  refreshText: { color: '#BAE6FD', fontSize: 10, fontWeight: '800' },
  notice: { color: '#FBBF24', backgroundColor: '#422006', borderRadius: 8, padding: 10, fontSize: 10, lineHeight: 15 },
  summaryRow: { flexDirection: 'row', gap: 8 },
  summaryCard: { flex: 1, backgroundColor: '#111C2E', borderWidth: 1, borderColor: '#263449', borderRadius: 11, padding: 10 },
  summaryValue: { color: '#F8FAFC', fontSize: 19, fontWeight: '900' },
  summaryLabel: { color: '#64748B', fontSize: 7, fontWeight: '900', letterSpacing: 0.8, marginTop: 3 },
  sectionTitle: { color: '#64748B', fontSize: 9, fontWeight: '900', letterSpacing: 1.3, marginTop: 5, marginBottom: -2 },
  card: { backgroundColor: '#111C2E', borderWidth: 1, borderColor: '#263449', borderRadius: 14, padding: 12, gap: 9 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  avatar: { width: 37, height: 37, borderRadius: 12, backgroundColor: '#0C4A6E', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#BAE6FD', fontWeight: '900', fontSize: 15 },
  orderIcon: { width: 37, height: 37, borderRadius: 12, backgroundColor: '#172554', alignItems: 'center', justifyContent: 'center' },
  orderIconText: { color: '#93C5FD', fontSize: 20, fontWeight: '900' },
  cardCopy: { flex: 1 },
  cardTitle: { color: '#F8FAFC', fontSize: 12, fontWeight: '900' },
  subtle: { color: '#94A3B8', fontSize: 9, lineHeight: 14, marginTop: 2 },
  badge: { borderRadius: 20, paddingHorizontal: 7, paddingVertical: 5, borderWidth: 1 },
  badgeGood: { backgroundColor: '#052E2B', borderColor: '#047857' },
  badgePending: { backgroundColor: '#292014', borderColor: '#92400E' },
  badgeText: { fontSize: 7, fontWeight: '900', letterSpacing: 0.4 },
  badgeTextGood: { color: '#6EE7B7' },
  badgeTextPending: { color: '#FCD34D' },
  outcome: { color: '#CBD5E1', backgroundColor: '#0F172A', padding: 8, borderRadius: 7, fontSize: 9 },
  assignment: { backgroundColor: '#0F172A', padding: 9, borderRadius: 8 },
  label: { color: '#64748B', fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  assignmentName: { color: '#E2E8F0', fontSize: 10, fontWeight: '800', marginTop: 3 },
  resultBox: { padding: 9, borderRadius: 8, gap: 3 },
  resultGood: { backgroundColor: '#052E2B', borderWidth: 1, borderColor: '#047857' },
  resultRisk: { backgroundColor: '#3F1519', borderWidth: 1, borderColor: '#991B1B' },
  resultNeutral: { backgroundColor: '#172033', borderWidth: 1, borderColor: '#334155' },
  resultTitle: { color: '#E2E8F0', fontSize: 10, fontWeight: '800' },
  helper: { color: '#FBBF24', fontSize: 9, lineHeight: 14 },
  button: { minHeight: 40, justifyContent: 'center', alignItems: 'center', backgroundColor: '#2563EB', borderRadius: 9, paddingHorizontal: 10 },
  buttonText: { color: '#F8FAFC', fontSize: 10, fontWeight: '900', textAlign: 'center' },
  disabled: { opacity: 0.45 },
  footer: { backgroundColor: '#132238', borderWidth: 1, borderColor: '#26466C', borderRadius: 12, padding: 12, gap: 5 },
  footerTitle: { color: '#93C5FD', fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  cameraScreen: { flex: 1, backgroundColor: '#020617' },
  cameraOverlay: { flex: 1, justifyContent: 'space-between', padding: 18, paddingTop: 48, paddingBottom: 30, backgroundColor: 'rgba(2, 6, 23, 0.25)' },
  cameraTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cameraEyebrow: { color: '#7DD3FC', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  cameraTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '900', marginTop: 4 },
  closeButton: { backgroundColor: '#0F172A', borderWidth: 1, borderColor: '#475569', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 9 },
  closeText: { color: '#F8FAFC', fontSize: 10, fontWeight: '800' },
  faceGuide: { width: 220, height: 285, borderRadius: 120, borderWidth: 2, borderColor: '#38BDF8', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15, 23, 42, 0.08)' },
  faceGuideInner: { width: 180, height: 245, borderRadius: 100, borderWidth: 1, borderColor: 'rgba(186, 230, 253, 0.65)' },
  cameraBottom: { gap: 12 },
  cameraHint: { color: '#E2E8F0', textAlign: 'center', fontSize: 10, lineHeight: 16 },
  captureButton: { backgroundColor: '#38BDF8', borderRadius: 13, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  captureText: { color: '#082F49', fontSize: 12, fontWeight: '900' },
});
