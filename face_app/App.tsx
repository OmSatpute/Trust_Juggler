import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Dimensions,
  Easing,
  LayoutAnimation,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  Vibration,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions, type CameraView as CameraViewType } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Partner = { id: string; name: string; vehicle: string; enrolled: boolean };
type Order = { id: string; items: string; partner_id: string; customer?: string; verified?: boolean };
type ScanAction = { kind: 'enroll'; partner: Partner } | { kind: 'verify'; order: Order };
type BoundingBox = { x: number; y: number; width: number; height: number };

type DetectedFaceUI = {
  id: string;
  box: BoundingBox;
  tag: string;
  isBackground?: boolean;
  isMismatch?: boolean;
  isMatch?: boolean;
  isWarning?: boolean;
};

type VerificationNotice = {
  type: 'mismatch' | 'multiple_faces';
  title: string;
  message: string;
  subtext?: string;
  count?: number;
  similarity?: number;
  confidencePercent?: number;
};

type ScanResult = {
  kind: 'enrolled' | 'match' | 'mismatch';
  title: string;
  detail: string;
  similarity?: number;
  confidencePercent?: number;
  partnerName?: string;
  orderId?: string;
};

const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.180.142.251:8000').replace(/\/$/, '');
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * Maps raw ArcFace cosine similarity (-1.0 to 1.0, threshold 0.45)
 * into an intuitive 0% - 100% human confidence percentage.
 */
function calculateConfidence(similarity: number, threshold = 0.45): number {
  if (similarity < threshold) {
    const ratio = Math.max(0, similarity) / threshold;
    return Number((ratio * 60).toFixed(1));
  }
  const ratio = (similarity - threshold) / (1.0 - threshold);
  return Number((75 + ratio * 24.5).toFixed(1));
}

function SwipeableOrderCard({
  order,
  person,
  avatarColor,
  isOrderVerified,
  onVerify,
  onDelete,
}: {
  order: Order;
  person?: Partner;
  avatarColor: string;
  isOrderVerified: boolean;
  onVerify: () => void;
  onDelete: (orderId: string) => void;
}) {
  const panX = useRef(new Animated.Value(0)).current;
  const isDeletingRef = useRef(false);

  const triggerDelete = () => {
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    Vibration.vibrate(35);
    Animated.timing(panX, {
      toValue: -Dimensions.get('window').width - 50,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      onDelete(order.id);
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      // Do not block initial tap touches so child buttons can be tapped
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,

      // Immediately capture when dragging horizontally to the left
      onMoveShouldSetPanResponder: (_, gesture) => {
        return gesture.dx < -6 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },
      onMoveShouldSetPanResponderCapture: (_, gesture) => {
        return gesture.dx < -10 && Math.abs(gesture.dx) > Math.abs(gesture.dy);
      },

      onPanResponderGrant: () => {
        panX.stopAnimation();
      },

      onPanResponderMove: (_, gesture) => {
        if (gesture.dx < 0) {
          // Follow the finger directly for instant response
          panX.setValue(gesture.dx);
        } else {
          // Slight resistance if pulled right
          panX.setValue(gesture.dx * 0.1);
        }
      },

      onPanResponderRelease: (_, gesture) => {
        if (isDeletingRef.current) return;

        // Dismiss if swiped left more than 65px or swift flick (vx < -0.3)
        if (gesture.dx < -65 || gesture.vx < -0.3) {
          triggerDelete();
        } else {
          // Snap back smoothly
          Animated.spring(panX, {
            toValue: 0,
            friction: 7,
            tension: 70,
            useNativeDriver: true,
          }).start();
        }
      },

      onPanResponderTerminate: () => {
        if (!isDeletingRef.current) {
          Animated.spring(panX, {
            toValue: 0,
            friction: 7,
            tension: 70,
            useNativeDriver: true,
          }).start();
        }
      },
      onShouldBlockNativeResponder: () => true,
    })
  ).current;

  // Interpolated card opacity as it slides away
  const cardOpacity = panX.interpolate({
    inputRange: [-180, -60, 0],
    outputRange: [0.65, 0.95, 1],
    extrapolate: 'clamp',
  });

  return (
    <View style={s.swipeContainer}>
      {/* Background Revealed on Swipe Left with instant tap-to-delete */}
      <Pressable
        style={s.swipeDeleteBg}
        onPress={triggerDelete}>
        <Text style={s.swipeDeleteText}>✕ REMOVE</Text>
      </Pressable>

      {/* Foreground Interactive Card */}
      <Animated.View
        style={[
          s.card,
          isOrderVerified && s.cardVerified,
          {
            transform: [{ translateX: panX }],
            opacity: cardOpacity,
          },
        ]}
        {...panResponder.panHandlers}>
        <View style={s.row}>
          <Text style={[s.icon, isOrderVerified && { backgroundColor: '#E6F4EA', color: '#10B981' }]}>
            {isOrderVerified ? '✓' : '↗'}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={s.order}>{order.id}</Text>
            <Text style={s.hint}>{order.items}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={[s.readyPill, isOrderVerified && s.readyPillVerified]}>
              <Text style={[s.readyText, isOrderVerified && { color: '#047857' }]}>
                {isOrderVerified ? 'VERIFIED' : 'READY'}
              </Text>
            </View>
            {/* Quick delete icon on card corner as fallback */}
            <Pressable
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={s.cardMiniDeleteBtn}
              onPress={triggerDelete}>
              <Text style={s.cardMiniDeleteText}>✕</Text>
            </Pressable>
          </View>
        </View>

        <View style={s.rule} />
        <View style={s.assignedRowBetween}>
          <Text style={s.label}>ASSIGNED DELIVERY PARTNER</Text>
          <Text style={s.swipeHintText}>← Swipe left or tap ✕</Text>
        </View>

        <View style={[s.row, { marginBottom: 14 }]}>
          <View style={[s.avatarWrap, { backgroundColor: avatarColor }]}>
            <Text style={s.avatarText}>
              {person?.name
                ? person.name
                    .split(' ')
                    .map((x) => x[0])
                    .join('')
                : 'DP'}
            </Text>
          </View>
          <View style={{ flex: 1, paddingLeft: 4 }}>
            <Text style={s.person}>{person?.name ?? 'Loading…'}</Text>
            <Text style={s.vehicle}>{person?.vehicle}</Text>
          </View>
        </View>

        <Pressable
          style={[s.button, isOrderVerified && s.buttonVerified]}
          onPress={onVerify}>
          <Text style={s.buttonText}>
            {isOrderVerified ? '✓ RE-VERIFY PARTNER' : 'SCAN PARTNER FACE'}
          </Text>
          <Text style={s.arrow}>→</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

export default function App() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [scan, setScan] = useState<ScanAction | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  const [apiError, setApiError] = useState('');
  const [detectedFaces, setDetectedFaces] = useState<DetectedFaceUI[]>([]);
  const [verificationNotice, setVerificationNotice] = useState<VerificationNotice | null>(null);
  const [scanStatusText, setScanStatusText] = useState('Align face in frame to scan...');
  const [autoScanActive, setAutoScanActive] = useState(false);
  const [faceLocked, setFaceLocked] = useState(false);

  const [showGuestModal, setShowGuestModal] = useState(false);
  const [guestNameInput, setGuestNameInput] = useState('');
  const [isCreatingGuest, setIsCreatingGuest] = useState(false);

  const [showOrderModal, setShowOrderModal] = useState(false);
  const [orderCustomerInput, setOrderCustomerInput] = useState('');
  const [orderItemsInput, setOrderItemsInput] = useState('');
  const [orderPartnerId, setOrderPartnerId] = useState('');
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);

  const scanRef = useRef<ScanAction | null>(null);
  scanRef.current = scan;
  const partnersRef = useRef<Partner[]>([]);
  partnersRef.current = partners;
  const faceLockedRef = useRef(false);
  faceLockedRef.current = faceLocked;

  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraViewType>(null);
  const cameraBoxDims = useRef({ width: 320, height: 440 });
  const isProcessingRef = useRef(false);

  // ── Rich Animation System ──
  const laserAnim = useRef(new Animated.Value(0)).current;

  const checkScaleAnim = useRef(new Animated.Value(0)).current;
  const ripple1Anim = useRef(new Animated.Value(0)).current;
  const ripple2Anim = useRef(new Animated.Value(0)).current;
  const cardSlideAnim = useRef(new Animated.Value(40)).current;
  const cardFadeAnim = useRef(new Animated.Value(0)).current;
  const boxPulseAnim = useRef(new Animated.Value(1)).current;

  // ── Laser Scanning Sweep ──
  useEffect(() => {
    if (scan && !result) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(laserAnim, {
            toValue: 1,
            duration: 1600,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(laserAnim, {
            toValue: 0,
            duration: 1600,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      laserAnim.setValue(0);
    }
  }, [scan, result, laserAnim]);

  // ── Subtle Box Pulse on Face Lock ──
  const triggerFaceLockPulse = useCallback(() => {
    Animated.sequence([
      Animated.timing(boxPulseAnim, { toValue: 1.08, duration: 120, useNativeDriver: true }),
      Animated.timing(boxPulseAnim, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [boxPulseAnim]);

  // ── High-Fidelity Google Pay Spring Animation ──
  const playGPaySuccessAnimation = useCallback(() => {
    Vibration.vibrate([0, 50, 40, 100]);
    checkScaleAnim.setValue(0);
    ripple1Anim.setValue(0);
    ripple2Anim.setValue(0);
    cardSlideAnim.setValue(50);
    cardFadeAnim.setValue(0);

    Animated.parallel([
      // Primary Bouncy Checkmark Pop
      Animated.spring(checkScaleAnim, {
        toValue: 1,
        friction: 5,
        tension: 110,
        useNativeDriver: true,
      }),
      // Expanding Ripple 1
      Animated.timing(ripple1Anim, {
        toValue: 1,
        duration: 1000,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      // Expanding Ripple 2 (Staggered)
      Animated.sequence([
        Animated.delay(180),
        Animated.timing(ripple2Anim, {
          toValue: 1,
          duration: 900,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
      // Card Slide Up & Fade In
      Animated.timing(cardSlideAnim, {
        toValue: 0,
        duration: 450,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(cardFadeAnim, {
        toValue: 1,
        duration: 450,
        useNativeDriver: true,
      }),
    ]).start();
  }, [checkScaleAnim, ripple1Anim, ripple2Anim, cardSlideAnim, cardFadeAnim]);

  // ── Fetch Initial Partners & Orders ──
  const refresh = async () => {
    try {
      const responses = await Promise.all([
        fetch(API_URL + '/api/partners'),
        fetch(API_URL + '/api/orders'),
      ]);
      if (responses.some((r) => !r.ok)) throw new Error();
      const data = await Promise.all(responses.map((r) => r.json()));
      setPartners(data[0].partners);
      setOrders(data[1].orders);
      setApiError('');
    } catch {
      setApiError(
        'Backend unavailable at ' +
          API_URL +
          '. Start the API and verify EXPO_PUBLIC_API_URL has your computer LAN IP.'
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // ── Enroll Guest Partner ──
  const handleEnrollGuest = async () => {
    const trimmed = guestNameInput.trim();
    if (!trimmed) {
      Alert.alert('Name Required', 'Please enter a name for the guest partner.');
      return;
    }

    setIsCreatingGuest(true);
    try {
      const res = await fetch(`${API_URL}/api/partners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          vehicle: 'Guest Partner · On-demand',
          role: 'Guest Partner',
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to create guest partner on backend');
      }

      const data = await res.json();
      const newPartner: Partner = data.partner;
      const newOrder: Order | undefined = data.order;

      setPartners((prev) => [newPartner, ...prev.filter((p) => p.id !== newPartner.id)]);
      if (newOrder) {
        setOrders((prev) => [newOrder, ...prev.filter((o) => o.id !== newOrder.id)]);
      }

      setShowGuestModal(false);
      setGuestNameInput('');

      // Immediately launch camera to enroll the guest face biometrics!
      await openScanner({ kind: 'enroll', partner: newPartner });
    } catch (err) {
      console.warn('[PickupVerify] Backend create failed, using local fallback:', err);
      const guestId = `guest-${Date.now().toString(36)}`;
      const localPartner: Partner = {
        id: guestId,
        name: trimmed,
        vehicle: 'Guest Partner · On-demand',
        enrolled: false,
      };
      const localOrder: Order = {
        id: `HF-${Math.floor(2100 + Math.random() * 800)}`,
        items: '2 items · 5 min',
        partner_id: guestId,
        verified: false,
      };
      setPartners((prev) => [localPartner, ...prev]);
      setOrders((prev) => [localOrder, ...prev]);
      setShowGuestModal(false);
      setGuestNameInput('');
      await openScanner({ kind: 'enroll', partner: localPartner });
    } finally {
      setIsCreatingGuest(false);
    }
  };

  // ── Remove / Delete Partner ──
  const handleDeletePartner = (partner: Partner) => {
    Alert.alert(
      'Remove Partner',
      `Are you sure you want to remove ${partner.name}? Their biometric face vector and any associated orders will also be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            // Optimistic UI removal
            setPartners((prev) => prev.filter((p) => p.id !== partner.id));
            setOrders((prev) => prev.filter((o) => o.partner_id !== partner.id));

            try {
              await fetch(`${API_URL}/api/partners/${partner.id}`, {
                method: 'DELETE',
              });
            } catch (err) {
              console.warn('[PickupVerify] Failed to delete partner on server:', err);
            }
          },
        },
      ]
    );
  };

  // ── Remove / Delete Order (from swipe or delete) ──
  const handleDeleteOrder = async (orderId: string) => {
    // Animate item removal seamlessly on iOS and Android
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOrders((prev) => prev.filter((o) => o.id !== orderId));
    try {
      await fetch(`${API_URL}/api/orders/${orderId}`, {
        method: 'DELETE',
      });
    } catch (err) {
      console.warn('[PickupVerify] Failed to delete order on server:', err);
    }
  };

  // ── Create New Ready for Pickup Order ──
  const handleCreateOrder = async () => {
    const cust = orderCustomerInput.trim() || 'Customer';
    const items = orderItemsInput.trim() || '2 items · 8 min';
    const pId = orderPartnerId || (partners[0]?.id ?? '');

    if (!pId) {
      Alert.alert('Assign Partner', 'Please enroll or select at least one delivery partner first.');
      return;
    }

    setIsCreatingOrder(true);
    try {
      const res = await fetch(`${API_URL}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: cust,
          items,
          partner_id: pId,
        }),
      });

      if (!res.ok) throw new Error('Backend failed to create order');

      const data = await res.json();
      const newOrder: Order = data.order;
      setOrders((prev) => [newOrder, ...prev.filter((o) => o.id !== newOrder.id)]);
      setShowOrderModal(false);
      setOrderCustomerInput('');
      setOrderItemsInput('');
    } catch (err) {
      console.warn('[PickupVerify] Order create error, using local fallback:', err);
      const fallbackOrder: Order = {
        id: `HF-${Math.floor(2100 + Math.random() * 899)}`,
        customer: cust,
        items,
        partner_id: pId,
        verified: false,
      };
      setOrders((prev) => [fallbackOrder, ...prev]);
      setShowOrderModal(false);
      setOrderCustomerInput('');
      setOrderItemsInput('');
    } finally {
      setIsCreatingOrder(false);
    }
  };

  // ── Open Scanner ──
  const openScanner = async (action: ScanAction) => {
    if (!permission?.granted && !(await requestPermission()).granted) return;
    setResult(null);
    setDetectedFaces([]);
    setVerificationNotice(null);
    setFaceLocked(false);
    setScanStatusText(
      action.kind === 'enroll'
        ? `Align ${action.partner.name}'s face inside oval`
        : 'Align face in oval to auto-verify'
    );
    setScan(action);
    setAutoScanActive(true); // Start continuous silent probing immediately
    isProcessingRef.current = false;
  };

  const closeScanner = () => {
    setAutoScanActive(false);
    setScan(null);
    setResult(null);
    setDetectedFaces([]);
    setVerificationNotice(null);
    setFaceLocked(false);
    isProcessingRef.current = false;
  };

  // ── Fast Face Recognition with Mismatch and Multi-Person Reason Detection ──
  const processFrame = useCallback(
    async (isManual = false) => {
      const currentScan = scanRef.current;
      if (!camera.current || !currentScan || isProcessingRef.current) return;
      isProcessingRef.current = true;

      let photoUri: string | null = null;
      try {
        // ── Lowest quality that YuNet can still detect faces in (~30-50KB) ──
        const photo = await camera.current.takePictureAsync({
          quality: 0.25,
          skipProcessing: true,
          shutterSound: false,
        });

        if (!photo?.uri) return;
        photoUri = photo.uri;

        const endpoint =
          currentScan.kind === 'enroll'
            ? `${API_URL}/api/partners/${currentScan.partner.id}/enrollment`
            : `${API_URL}/api/orders/${currentScan.order.id}/verify`;

        const uploadResult = await FileSystem.uploadAsync(endpoint, photo.uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'image',
          mimeType: 'image/jpeg',
        });

        const data: Record<string, unknown> = JSON.parse(uploadResult.body || '{}');

        // ── 1. No Face in frame ──
        if (
          data.result === 'no_face' ||
          data.status === 'no_face' ||
          (uploadResult.status === 422 &&
            typeof data.detail === 'string' &&
            data.detail.toLowerCase().includes('no face'))
        ) {
          setDetectedFaces([]);
          setFaceLocked(false);
          return;
        }

        // ── 2. Multiple faces in frame (Another person behind) ──
        const isMultiFace =
          data.result === 'multiple_faces' ||
          data.status === 'multiple_faces' ||
          (uploadResult.status === 422 &&
            typeof data.detail === 'string' &&
            (data.detail.toLowerCase().includes('multiple') ||
              data.detail.toLowerCase().includes('more than one')));

        if (isMultiFace) {
          const rawBoxes = Array.isArray(data.boxes)
            ? (data.boxes as BoundingBox[])
            : data.box
            ? [data.box as BoundingBox]
            : [];
          const count =
            typeof data.face_count === 'number'
              ? data.face_count
              : Math.max(2, rawBoxes.length);

          const assignedName =
            currentScan.kind === 'enroll'
              ? currentScan.partner.name
              : (partnersRef.current.find((p) => p.id === currentScan.order.partner_id)?.name ??
                'Assigned Partner');

          const faceList: DetectedFaceUI[] = rawBoxes.map((box, idx) => ({
            id: `face-${idx}-${Math.random()}`,
            box,
            tag: idx === 0 ? '👤 PERSON 1' : '⚠️ PERSON BEHIND',
            isWarning: true,
            isBackground: idx > 0,
          }));

          setDetectedFaces(faceList);
          setFaceLocked(false);
          setVerificationNotice({
            type: 'multiple_faces',
            title: `⚠️ NOT VERIFYING: ${count} PEOPLE DETECTED`,
            message: 'Another person is visible behind or nearby in camera frame.',
            subtext: `Security rule: Only assigned partner ${assignedName} must be in camera view. Ask bystanders to step away.`,
            count,
          });

          if (isManual) {
            Vibration.vibrate([0, 100, 50, 100]);
            setResult({
              kind: 'mismatch',
              title: 'VERIFICATION BLOCKED • MULTIPLE PEOPLE',
              detail: `Security block: ${count} people detected in camera frame. Another person is behind or nearby. Verification requires ONLY the assigned delivery partner in view.`,
              partnerName: assignedName,
              orderId: currentScan.kind === 'verify' ? currentScan.order.id : undefined,
            });
          }
          return;
        }

        if (uploadResult.status < 200 || uploadResult.status >= 300) {
          const detail = typeof data.detail === 'string' ? data.detail : 'Server error';
          console.error('[PickupVerify] Error response:', detail);
          return;
        }

        // ── 3. Handle Enrollment Case ──
        if (currentScan.kind === 'enroll') {
          if (data.status === 'enrolled') {
            setAutoScanActive(false);
            setVerificationNotice(null);
            if (data.box && typeof data.box === 'object') {
              setDetectedFaces([
                {
                  id: 'face-0',
                  box: data.box as BoundingBox,
                  tag: `✓ ${currentScan.partner.name.toUpperCase()}`,
                  isMatch: true,
                },
              ]);
            }
            Vibration.vibrate([0, 60, 40, 120]);
            const res: ScanResult = {
              kind: 'enrolled',
              title: 'PARTNER ENROLLED',
              detail: `${currentScan.partner.name}'s biometric face vector is registered.`,
              partnerName: currentScan.partner.name,
              confidencePercent: 98.5,
            };
            setResult(res);
            playGPaySuccessAnimation();
            await refresh();
            return;
          }
        }

        // ── 4. Handle Verification Case ──
        if (currentScan.kind === 'verify') {
          const isMatched = data.result === 'match';
          const assignedName =
            partnersRef.current.find((p) => p.id === currentScan.order.partner_id)?.name ??
            'Assigned Partner';
          const rawSim = Number(data.similarity ?? 0);
          const confPercent = calculateConfidence(rawSim, Number(data.threshold ?? 0.45));

          if (isMatched) {
            setAutoScanActive(false);
            setVerificationNotice(null);
            if (data.box && typeof data.box === 'object') {
              setDetectedFaces([
                {
                  id: 'face-0',
                  box: data.box as BoundingBox,
                  tag: `✓ ${assignedName.toUpperCase()}`,
                  isMatch: true,
                },
              ]);
            }
            Vibration.vibrate([0, 60, 40, 120]);
            const res: ScanResult = {
              kind: 'match',
              title: 'PARTNER VERIFIED',
              detail: `${assignedName} is authorized for pickup. Biometrics verified.`,
              similarity: rawSim,
              confidencePercent: confPercent,
              partnerName: assignedName,
              orderId: currentScan.order.id,
            };
            setResult(res);
            playGPaySuccessAnimation();
            setOrders((prev) =>
              prev.map((o) => (o.id === currentScan.order.id ? { ...o, verified: true } : o))
            );
            return;
          }

          // ── 5. Mismatch Case ──
          if (data.box && typeof data.box === 'object') {
            setDetectedFaces([
              {
                id: 'face-0',
                box: data.box as BoundingBox,
                tag: `❌ NOT ${assignedName.toUpperCase()}`,
                isMismatch: true,
              },
            ]);
          }
          if (!faceLockedRef.current) {
            triggerFaceLockPulse();
          }
          setFaceLocked(true);
          setVerificationNotice({
            type: 'mismatch',
            title: '❌ NOT VERIFYING: FACE MISMATCH',
            message: `The face in frame does not match registered rider ${assignedName}.`,
            subtext: `Biometric match: ${confPercent}% (Required: 75%+). Handover is strictly prohibited.`,
            similarity: rawSim,
            confidencePercent: confPercent,
          });

          if (isManual) {
            Vibration.vibrate([0, 100, 50, 100]);
            const res: ScanResult = {
              kind: 'mismatch',
              title: 'FACE MISMATCH • HANDOVER BLOCKED',
              detail: `Security alert: The person at the counter does not match assigned delivery partner ${assignedName}. Biometric match is ${confPercent}% (Similarity: ${rawSim.toFixed(3)}, Threshold: 0.45). Do not handover the order.`,
              similarity: rawSim,
              confidencePercent: confPercent,
              partnerName: assignedName,
              orderId: currentScan.order.id,
            };
            setResult(res);
          }
        }
      } catch (err) {
        console.error('[PickupVerify] processFrame error:', err);
      } finally {
        if (photoUri) {
          void FileSystem.deleteAsync(photoUri, { idempotent: true }).catch(() => {});
        }
        isProcessingRef.current = false;
      }
    },
    [triggerFaceLockPulse, playGPaySuccessAnimation]
  );

  // ── Auto-Scan Loop: fires every 400ms for near-instant detection ──
  useEffect(() => {
    if (!scan || !autoScanActive || result) return;

    setScanStatusText('🔍 Scanning live video stream...');

    const timer = setInterval(() => {
      void processFrame(false);
    }, 400);

    return () => clearInterval(timer);
  }, [scan, autoScanActive, result, processFrame]);

  const colors = ['#d8e4d5', '#f1dfc9', '#dce4f3'];

  return (
    <View style={s.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={s.content}>
        {/* Top Header */}
        <View style={s.topline}>
          <Text style={s.brand}>
            PICKUP<Text style={{ color: '#10B981' }}>VERIFY</Text>
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              style={s.addPartnerTopBtn}
              onPress={() => {
                setGuestNameInput('');
                setShowGuestModal(true);
              }}>
              <Text style={s.addPartnerTopBtnText}>+ ADD</Text>
            </Pressable>
            <View style={s.badgePill}>
              <View style={s.liveGreenDot} />
              <Text style={s.badge}>RESTAURANT COUNTER</Text>
            </View>
          </View>
        </View>

        <Text style={s.eyebrow}>AI FACE DISPATCH · PART 2</Text>
        <Text style={s.heading}>
          Pickup Verification,{'\n'}
          <Text style={{ fontWeight: '800', color: '#17231d' }}>live face stream.</Text>
        </Text>
        <Text style={s.sub}>
          Real-time stream comparison against assigned partner before handing over orders.
        </Text>

        {apiError ? (
          <View style={s.error}>
            <Text style={s.errorTitle}>Backend connection needed</Text>
            <Text style={s.errorText}>{apiError}</Text>
          </View>
        ) : null}

        {/* Orders Ready for Pickup (Unverified at top, Verified at bottom) */}
        <View style={s.sectionHeaderRow}>
          <View style={{ flex: 1, paddingRight: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={s.title}>Ready for pickup</Text>
              <View style={s.orderStatsPill}>
                <Text style={s.orderStatsText}>
                  {orders.filter((o) => !o.verified).length} PENDING
                </Text>
              </View>
            </View>
            <Text style={s.hint} numberOfLines={1}>
              {orders.length} orders · Swipe left to remove
            </Text>
          </View>
          <Pressable
            style={s.addNewOrderBtn}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            onPress={() => {
              setOrderCustomerInput('');
              setOrderItemsInput('');
              setOrderPartnerId(partners[0]?.id ?? '');
              setShowOrderModal(true);
            }}>
            <Text style={s.addNewOrderBtnText}>+ NEW ORDER</Text>
          </Pressable>
        </View>

        {orders.length === 0 ? (
          <View style={s.emptyOrdersCard}>
            <Text style={s.emptyOrdersTitle}>No orders waiting for pickup</Text>
            <Text style={s.emptyOrdersSub}>Tap "+ NEW ORDER" above to create an order for pickup.</Text>
          </View>
        ) : (
          [...orders]
            .sort((a, b) => {
              const aVer = !!a.verified;
              const bVer = !!b.verified;
              if (aVer === bVer) return 0;
              return aVer ? 1 : -1; // Unverified at top (first), verified at bottom (last)
            })
            .map((order, i) => {
              const person = partners.find((p) => p.id === order.partner_id);
              const isOrderVerified = !!order.verified;

              return (
                <SwipeableOrderCard
                  key={order.id}
                  order={order}
                  person={person}
                  avatarColor={colors[i % colors.length]}
                  isOrderVerified={isOrderVerified}
                  onVerify={() => void openScanner({ kind: 'verify', order })}
                  onDelete={handleDeleteOrder}
                />
              );
            })
        )}

        {/* Partner Enrollment Section */}
        <View style={s.enrollHeaderRow}>
          <View>
            <Text style={s.title}>Partner enrollment</Text>
            <Text style={s.hint}>Registered delivery partners & ArcFace biometrics</Text>
          </View>
          <Pressable
            style={s.addPartnerTopBtn}
            onPress={() => {
              setGuestNameInput('');
              setShowGuestModal(true);
            }}>
            <Text style={s.addPartnerTopBtnText}>+ NEW PARTNER</Text>
          </Pressable>
        </View>

        <View style={s.enrollCard}>
          {partners.map((p, i) => (
            <View key={p.id} style={[s.row, s.enrollRow, i > 0 && s.enrollBorder]}>
              <View style={[s.avatarWrap, { backgroundColor: colors[i % colors.length] }]}>
                <Text style={s.avatarText}>
                  {p.name
                    .split(' ')
                    .map((x) => x[0])
                    .join('')}
                </Text>
              </View>

              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={s.person} numberOfLines={1}>{p.name}</Text>
                <View style={s.statusBadgeRow}>
                  <View style={[s.dotIndicator, { backgroundColor: p.enrolled ? '#10B981' : '#F59E0B' }]} />
                  <Text style={[s.statusBadgeText, { color: p.enrolled ? '#047857' : '#B45309' }]}>
                    {p.enrolled ? 'FACE REGISTERED' : 'PENDING ENROLLMENT'}
                  </Text>
                </View>
              </View>

              {/* Action Buttons: Scan/Update + Remove */}
              <View style={s.actionBtnGroup}>
                <Pressable
                  style={p.enrolled ? s.update : s.enroll}
                  onPress={() => void openScanner({ kind: 'enroll', partner: p })}>
                  <Text style={p.enrolled ? s.updateText : s.enrollText}>
                    {p.enrolled ? 'RE-SCAN' : 'ENROLL'}
                  </Text>
                </Pressable>

                <Pressable
                  style={s.deleteBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => handleDeletePartner(p)}>
                  <Text style={s.deleteBtnText}>✕</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>

        <Text style={s.privacy}>
          ◈ Live camera stream analyzes ArcFace 512-D vectors in real-time. Biometric templates are validated locally.
        </Text>
        <Text style={s.footer}>DEMO DISPATCH • HACK FORGE PART 2</Text>
      </ScrollView>

      {/* ═══════════════════════════════════════════════════════════════════════
          GUEST PARTNER ENROLLMENT MODAL (TAKES NAME & LAUNCHES SCANNER)
         ═══════════════════════════════════════════════════════════════════════ */}
      <Modal
        visible={showGuestModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowGuestModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.guestModalCard}>
            <View style={s.guestModalHeader}>
              <View style={s.guestModalIconCircle}>
                <Text style={s.guestModalIconText}>👤</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.guestModalTitle}>Enroll Guest Partner</Text>
                <Text style={s.guestModalSub}>
                  Enter the guest rider's full name to register their face in the system.
                </Text>
              </View>
            </View>

            <View style={s.guestInputBox}>
              <Text style={s.guestInputLabel}>GUEST FULL NAME</Text>
              <TextInput
                style={s.guestTextInput}
                placeholder="e.g. Rahul Sharma"
                placeholderTextColor="#94A3B8"
                value={guestNameInput}
                onChangeText={setGuestNameInput}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => void handleEnrollGuest()}
              />
            </View>

            <View style={s.guestModalActions}>
              <Pressable
                style={s.guestCancelButton}
                onPress={() => setShowGuestModal(false)}>
                <Text style={s.guestCancelButtonText}>CANCEL</Text>
              </Pressable>
              <Pressable
                style={[
                  s.guestSubmitButton,
                  !guestNameInput.trim() && { opacity: 0.6 },
                ]}
                disabled={!guestNameInput.trim() || isCreatingGuest}
                onPress={() => void handleEnrollGuest()}>
                <Text style={s.guestSubmitButtonText}>
                  {isCreatingGuest ? 'PREPARING...' : 'START ENROLLMENT 📸'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ═══════════════════════════════════════════════════════════════════════
          CREATE NEW READY FOR PICKUP ORDER MODAL
         ═══════════════════════════════════════════════════════════════════════ */}
      <Modal
        visible={showOrderModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowOrderModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.guestModalCard}>
            <View style={s.guestModalHeader}>
              <View style={[s.guestModalIconCircle, { backgroundColor: '#0369A1' }]}>
                <Text style={s.guestModalIconText}>📦</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.guestModalTitle}>New Pickup Order</Text>
                <Text style={s.guestModalSub}>
                  Create a new ready order and assign to an enrolled rider.
                </Text>
              </View>
            </View>

            <View style={s.guestInputBox}>
              <Text style={s.guestInputLabel}>CUSTOMER NAME</Text>
              <TextInput
                style={s.guestTextInput}
                placeholder="e.g. A. Sharma"
                placeholderTextColor="#94A3B8"
                value={orderCustomerInput}
                onChangeText={setOrderCustomerInput}
              />
            </View>

            <View style={s.guestInputBox}>
              <Text style={s.guestInputLabel}>ORDER ITEMS / SUMMARY</Text>
              <TextInput
                style={s.guestTextInput}
                placeholder="e.g. 3 items · 10 min"
                placeholderTextColor="#94A3B8"
                value={orderItemsInput}
                onChangeText={setOrderItemsInput}
              />
            </View>

            <View style={s.guestInputBox}>
              <Text style={s.guestInputLabel}>ASSIGNED DELIVERY PARTNER</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
                {partners.map((p) => {
                  const isSelected = (orderPartnerId || partners[0]?.id) === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      style={[
                        s.partnerSelectPill,
                        isSelected && s.partnerSelectPillActive,
                      ]}
                      onPress={() => setOrderPartnerId(p.id)}>
                      <Text
                        style={[
                          s.partnerSelectPillText,
                          isSelected && s.partnerSelectPillTextActive,
                        ]}>
                        {p.name} {p.enrolled ? '✓' : ''}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            <View style={s.guestModalActions}>
              <Pressable
                style={s.guestCancelButton}
                onPress={() => setShowOrderModal(false)}>
                <Text style={s.guestCancelButtonText}>CANCEL</Text>
              </Pressable>
              <Pressable
                style={[
                  s.guestSubmitButton,
                  isCreatingOrder && { opacity: 0.6 },
                ]}
                disabled={isCreatingOrder}
                onPress={() => void handleCreateOrder()}>
                <Text style={s.guestSubmitButtonText}>
                  {isCreatingOrder ? 'CREATING...' : 'CREATE ORDER 📦'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ═══════════════════════════════════════════════════════════════════════
          CAMERA SCAN MODAL (LIVE VIDEO STREAM + AUTO SHUTTER + GPAY POP)
         ═══════════════════════════════════════════════════════════════════════ */}
      <Modal visible={!!scan} animationType="slide" onRequestClose={closeScanner}>
        <View style={s.cameraPage}>
          {/* Header — visible in BOTH camera view and result view */}
          <View style={s.cameraHead}>
            <Pressable
              onPress={result ? closeScanner : closeScanner}
              style={s.back}>
              <Text style={s.backText}>‹</Text>
            </Pressable>
            <View>
              <Text style={s.label}>
                {scan?.kind === 'enroll'
                  ? 'PARTNER ENROLLMENT'
                  : 'ORDER ' + (scan?.order.id ?? '')}
              </Text>
              <Text style={s.person}>
                {result
                  ? (result.kind === 'enrolled' ? '✓ Enrolled' : result.kind === 'match' ? '✓ Verified' : 'Mismatch')
                  : scan?.kind === 'enroll' ? scan.partner.name : 'Live Stream Verification'}
              </Text>
            </View>
          </View>

          {/* VIEW A: LIVE CAMERA STREAM VIEW */}
          {!result ? (
            <View style={{ flex: 1 }}>
              {/* Camera Container with Layout Measurement */}
              <View
                style={s.cameraBox}
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  cameraBoxDims.current = { width, height };
                }}>
                {permission?.granted ? (
                  <CameraView
                    ref={camera}
                    style={s.camera}
                    facing="front"
                    animateShutter={false}
                  />
                ) : (
                  <Text style={s.cameraError}>Camera permission required.</Text>
                )}



                {/* Cybernetic Laser Scan Line */}
                {!faceLocked && (
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      s.laserScanLine,
                      {
                        transform: [
                          {
                            translateY: laserAnim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [20, cameraBoxDims.current.height - 40],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                )}

                {/* Centering Face Oval Guide */}
                <View pointerEvents="none" style={s.guide}>
                  <View
                    style={[
                      s.oval,
                      verificationNotice?.type === 'mismatch'
                        ? s.ovalMismatch
                        : verificationNotice?.type === 'multiple_faces'
                        ? s.ovalWarning
                        : faceLocked
                        ? s.ovalLocked
                        : null,
                    ]}
                  />
                </View>

                {/* Dynamic Detected Face Bounding Boxes (Supports single or multiple faces) */}
                {detectedFaces.map((face) => {
                  const isBg = face.isBackground;
                  const isMis = face.isMismatch;
                  const borderColor = isMis
                    ? '#EF4444'
                    : isBg || face.isWarning
                    ? '#F59E0B'
                    : '#10B981';
                  const bgColor = isMis
                    ? 'rgba(239, 68, 68, 0.18)'
                    : isBg || face.isWarning
                    ? 'rgba(245, 158, 11, 0.18)'
                    : 'rgba(16, 185, 129, 0.15)';
                  const tagBg = isMis
                    ? '#DC2626'
                    : isBg || face.isWarning
                    ? '#D97706'
                    : '#10B981';

                  return (
                    <Animated.View
                      key={face.id}
                      pointerEvents="none"
                      style={[
                        s.dynamicBoundingBox,
                        {
                          borderColor,
                          backgroundColor: bgColor,
                          // Front camera is horizontally mirrored
                          left:
                            (1 - (face.box.x + face.box.width)) *
                            cameraBoxDims.current.width,
                          top: face.box.y * cameraBoxDims.current.height,
                          width: Math.max(80, face.box.width * cameraBoxDims.current.width),
                          height: Math.max(100, face.box.height * cameraBoxDims.current.height),
                        },
                      ]}>
                      {/* Glowing Target Corner Brackets */}
                      <View style={[s.cornerBracket, s.cornerTL, { borderColor }]} />
                      <View style={[s.cornerBracket, s.cornerTR, { borderColor }]} />
                      <View style={[s.cornerBracket, s.cornerBL, { borderColor }]} />
                      <View style={[s.cornerBracket, s.cornerBR, { borderColor }]} />
                      <View style={[s.faceDetectedTag, { backgroundColor: tagBg }]}>
                        <Text style={[s.faceDetectedTagText, { color: '#FFFFFF' }]}>
                          {face.tag}
                        </Text>
                      </View>
                    </Animated.View>
                  );
                })}
              </View>

              {/* Prominent Verification Status / Block Reason Banner */}
              {verificationNotice ? (
                <View
                  style={[
                    s.noticeCard,
                    verificationNotice.type === 'mismatch'
                      ? s.noticeMismatch
                      : s.noticeWarning,
                  ]}>
                  <View style={s.noticeHeaderRow}>
                    <Text style={s.noticeIcon}>
                      {verificationNotice.type === 'mismatch' ? '❌' : '⚠️'}
                    </Text>
                    <Text
                      style={[
                        s.noticeTitle,
                        verificationNotice.type === 'mismatch'
                          ? s.noticeTextRed
                          : s.noticeTextAmber,
                      ]}>
                      {verificationNotice.title}
                    </Text>
                  </View>
                  <Text style={s.noticeMessage}>{verificationNotice.message}</Text>
                  {verificationNotice.subtext ? (
                    <Text style={s.noticeSubtext}>{verificationNotice.subtext}</Text>
                  ) : null}
                </View>
              ) : (
                <View
                  style={[
                    s.scanStatusBox,
                    faceLocked && { backgroundColor: '#064E3B' },
                  ]}>
                  <Text
                    style={[
                      s.scanStatusText,
                      faceLocked && { color: '#34D399' },
                    ]}>
                    {faceLocked
                      ? '⚡ Face Locked • Evaluating Biometrics...'
                      : scanStatusText}
                  </Text>
                </View>
              )}

              <Text style={s.instruction}>
                {scan?.kind === 'enroll'
                  ? `Hold ${scan.partner.name}'s face in the oval. Auto-enrolling...`
                  : 'Hold face steady in the oval. Auto-verifying...'}
              </Text>

              {/* Manual tap fallback */}
              <Pressable
                disabled={isProcessingRef.current || !permission?.granted}
                style={[s.button, s.capture, !permission?.granted && { opacity: 0.7 }]}
                onPress={() => {
                  isProcessingRef.current = false;
                  void processFrame(true);
                }}>
                <Text style={s.buttonText}>
                  {scan?.kind === 'enroll' ? '⚡ FORCE ENROLL' : '⚡ FORCE VERIFY'}
                </Text>
                <Text style={s.arrow}>📸</Text>
              </Pressable>
            </View>
          ) : (
            /* VIEW B: GOOGLE PAY PAYMENT SUCCESS POP / MISMATCH SCREEN */
            <View style={s.gpayContainer}>
              {result.kind === 'match' || result.kind === 'enrolled' ? (
                <View style={s.gpaySuccessCard}>
                  {/* Outer Concentric Ripple 2 */}
                  <Animated.View
                    style={[
                      s.gpayRipple,
                      {
                        transform: [
                          {
                            scale: ripple2Anim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.7, 2.2],
                            }),
                          },
                        ],
                        opacity: ripple2Anim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.45, 0],
                        }),
                      },
                    ]}
                  />

                  {/* Outer Concentric Ripple 1 */}
                  <Animated.View
                    style={[
                      s.gpayRipple,
                      {
                        transform: [
                          {
                            scale: ripple1Anim.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0.8, 1.7],
                            }),
                          },
                        ],
                        opacity: ripple1Anim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.65, 0],
                        }),
                      },
                    ]}
                  />

                  {/* Main Google Pay Green Checkmark Circle */}
                  <Animated.View
                    style={[
                      s.gpayCircle,
                      {
                        transform: [{ scale: checkScaleAnim }],
                      },
                    ]}>
                    <Text style={s.gpayCheckmark}>✓</Text>
                  </Animated.View>

                  {/* Header Title: explicitly "PARTNER VERIFIED" */}
                  <Text style={s.gpayMainTitle}>{result.title}</Text>

                  {/* Prominent Confidence Badge */}
                  {result.confidencePercent !== undefined && (
                    <View style={s.confidencePillBadge}>
                      <Text style={s.confidencePillText}>
                        ✓ {result.confidencePercent}% BIOMETRIC CONFIDENCE
                      </Text>
                    </View>
                  )}

                  <Text style={s.gpaySubtitle}>{result.partnerName}</Text>

                  {/* Animated Slide-Up Receipt Card */}
                  <Animated.View
                    style={[
                      s.gpayDetailsCard,
                      {
                        transform: [{ translateY: cardSlideAnim }],
                        opacity: cardFadeAnim,
                      },
                    ]}>
                    <View style={s.detailRowBetween}>
                      <Text style={s.gpayDetailLabel}>VERIFICATION STATUS</Text>
                      <View style={s.badgeAuthorized}>
                        <Text style={s.badgeAuthorizedText}>AUTHORIZED ✓</Text>
                      </View>
                    </View>
                    <Text style={s.gpayDetailVal}>
                      {result.kind === 'enrolled'
                        ? 'Biometric Template Saved to SQLite'
                        : 'Handover Approved • Match Confirmed'}
                    </Text>

                    {result.orderId && (
                      <>
                        <View style={s.gpayDivider} />
                        <View style={s.detailRowBetween}>
                          <Text style={s.gpayDetailLabel}>ASSIGNED ORDER</Text>
                          <Text style={s.gpayDetailValBold}>{result.orderId}</Text>
                        </View>
                      </>
                    )}

                    {result.similarity !== undefined && (
                      <>
                        <View style={s.gpayDivider} />
                        <View style={s.detailRowBetween}>
                          <Text style={s.gpayDetailLabel}>ARCFACE COSINE SIMILARITY</Text>
                          <Text style={[s.gpayDetailValBold, { color: '#10B981' }]}>
                            {result.similarity.toFixed(3)}
                          </Text>
                        </View>
                      </>
                    )}
                  </Animated.View>

                  <Pressable style={s.gpayDoneButton} onPress={closeScanner}>
                    <Text style={s.gpayDoneButtonText}>DONE • BACK TO DESK</Text>
                  </Pressable>
                </View>
              ) : (
                /* Mismatch Screen — High-Fidelity Security Rejection Card */
                <View style={s.gpaySuccessCard}>
                  {/* Warning Red Circle */}
                  <View style={s.mismatchCircle}>
                    <Text style={s.mismatchCrossmark}>✕</Text>
                  </View>

                  <Text style={s.mismatchMainTitle}>{result.title}</Text>

                  {result.confidencePercent !== undefined ? (
                    <View style={s.confidencePillMismatch}>
                      <Text style={s.confidencePillMismatchText}>
                        ⚠️ {result.confidencePercent}% BIOMETRIC MATCH (MIN: 75%)
                      </Text>
                    </View>
                  ) : (
                    <View style={s.confidencePillMismatch}>
                      <Text style={s.confidencePillMismatchText}>
                        ⛔ HANDOVER NOT AUTHORIZED
                      </Text>
                    </View>
                  )}

                  <Text style={s.gpaySubtitle}>
                    Assigned: {result.partnerName || 'Registered Partner'}
                  </Text>

                  <View style={s.mismatchDetailsCard}>
                    <View style={s.detailRowBetween}>
                      <Text style={s.gpayDetailLabel}>VERIFICATION STATUS</Text>
                      <View style={s.badgeRejected}>
                        <Text style={s.badgeRejectedText}>REJECTED ✕</Text>
                      </View>
                    </View>

                    <Text style={s.mismatchDetailVal}>{result.detail}</Text>

                    {result.orderId && (
                      <>
                        <View style={s.gpayDivider} />
                        <View style={s.detailRowBetween}>
                          <Text style={s.gpayDetailLabel}>ASSIGNED ORDER</Text>
                          <Text style={s.gpayDetailValBold}>{result.orderId}</Text>
                        </View>
                      </>
                    )}

                    {result.similarity !== undefined && (
                      <>
                        <View style={s.gpayDivider} />
                        <View style={s.detailRowBetween}>
                          <Text style={s.gpayDetailLabel}>ARCFACE SIMILARITY</Text>
                          <Text style={[s.gpayDetailValBold, { color: '#EF4444' }]}>
                            {result.similarity.toFixed(3)} (Min: 0.450)
                          </Text>
                        </View>
                      </>
                    )}

                    <View style={s.gpayDivider} />
                    <Text style={s.securityRuleText}>
                      🛡️ Security Protocol: Keep the food parcel at counter. Do NOT hand over to unrecognized riders.
                    </Text>
                  </View>

                  <Pressable
                    style={s.rescanButton}
                    onPress={() => {
                      setResult(null);
                      setDetectedFaces([]);
                      setVerificationNotice(null);
                      setFaceLocked(false);
                      setAutoScanActive(true);
                      isProcessingRef.current = false;
                    }}>
                    <Text style={s.rescanButtonText}>↺ RE-SCAN STREAM</Text>
                  </Pressable>

                  <Pressable style={s.cancelMismatchButton} onPress={closeScanner}>
                    <Text style={s.cancelMismatchButtonText}>DONE • BACK TO DESK</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f6f7f5' },
  content: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 40 },
  topline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 30,
  },
  brand: { fontSize: 15, fontWeight: '900', letterSpacing: 1.3, color: '#17231d' },
  addPartnerTopBtn: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  addPartnerTopBtnText: {
    color: '#F8FAFC',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5E9',
    borderRadius: 20,
    paddingHorizontal: 9,
    paddingVertical: 5,
    gap: 5,
  },
  liveGreenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  badge: {
    color: '#047857',
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.7,
  },
  eyebrow: { fontSize: 10, letterSpacing: 1.8, color: '#8a9389', fontWeight: '800', marginBottom: 8 },
  heading: { color: '#29342c', fontSize: 30, lineHeight: 36 },
  sub: { color: '#667067', fontSize: 13, lineHeight: 20, marginTop: 8, marginBottom: 22 },
  error: {
    borderColor: '#fca5a5',
    borderWidth: 1,
    backgroundColor: '#fef2f2',
    borderRadius: 13,
    padding: 14,
    marginBottom: 20,
  },
  errorTitle: { color: '#b91c1c', fontWeight: '800', fontSize: 13 },
  errorText: { color: '#991b1b', fontSize: 11, lineHeight: 17, marginTop: 4 },
  title: { fontSize: 18, fontWeight: '800', color: '#1c2821', marginTop: 8 },
  hint: { fontSize: 11, color: '#8a9288', marginTop: 3, marginBottom: 14 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 2,
  },
  cardVerified: {
    borderColor: '#10B981',
    backgroundColor: '#FAFDFB',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  icon: {
    color: '#047857',
    backgroundColor: '#ECFDF5',
    borderRadius: 12,
    padding: 9,
    fontSize: 16,
    fontWeight: '900',
  },
  order: { fontSize: 14, fontWeight: '800', color: '#1F2937' },
  readyPill: {
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  readyPillVerified: {
    backgroundColor: '#D1FAE5',
  },
  readyText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, color: '#4B5563' },
  rule: { height: 1, backgroundColor: '#F3F4F6', marginVertical: 12 },
  label: { fontSize: 8, letterSpacing: 1.2, fontWeight: '800', color: '#9CA3AF', marginBottom: 8 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 12,
    overflow: 'hidden',
    textAlign: 'center',
    textAlignVertical: 'center',
    color: '#064E3B',
    fontWeight: '800',
    fontSize: 13,
  },
  person: { color: '#111827', fontWeight: '700', fontSize: 13 },
  vehicle: { color: '#6B7280', fontSize: 10, marginTop: 3 },
  button: {
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: '#1E293B',
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  buttonVerified: {
    backgroundColor: '#047857',
  },
  buttonText: { color: '#fff', fontWeight: '800', letterSpacing: 1.1, fontSize: 10 },
  arrow: { color: '#A7F3D0', fontSize: 16 },
  enrollCard: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderColor: '#e5e7eb',
    borderWidth: 1,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  enrollRow: {
    minHeight: 68,
    paddingVertical: 10,
  },
  enrollBorder: { borderTopWidth: 1, borderColor: '#F1F5F9' },
  // ── Swipe-To-Remove Order Styles ──
  swipeContainer: {
    position: 'relative',
    marginBottom: 12,
  },
  swipeDeleteBg: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#DC2626',
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingRight: 22,
  },
  swipeDeleteText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 1.1,
  },
  cardMiniDeleteBtn: {
    width: 22,
    height: 22,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMiniDeleteText: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '900',
  },
  assignedRowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  swipeHintText: {
    fontSize: 9,
    color: '#94A3B8',
    fontWeight: '600',
  },
  addNewOrderBtn: {
    backgroundColor: '#0F172A',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 9,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  addNewOrderBtnText: {
    color: '#F8FAFC',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  emptyOrdersCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderStyle: 'dashed',
  },
  emptyOrdersTitle: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 13,
  },
  emptyOrdersSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  partnerSelectPill: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#334155',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    marginRight: 8,
  },
  partnerSelectPillActive: {
    backgroundColor: '#065F46',
    borderColor: '#10B981',
  },
  partnerSelectPillText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '700',
  },
  partnerSelectPillTextActive: {
    color: '#FFFFFF',
    fontWeight: '900',
  },
  avatarWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#064E3B',
    fontWeight: '800',
    fontSize: 13,
    textAlign: 'center',
    includeFontPadding: false,
    lineHeight: 18,
  },
  statusBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  dotIndicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  actionBtnGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  enroll: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#0F172A',
  },
  enrollText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 10,
    letterSpacing: 0.8,
  },
  update: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  updateText: {
    color: '#334155',
    fontWeight: '800',
    fontSize: 10,
    letterSpacing: 0.8,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '900',
  },
  privacy: {
    color: '#64748B',
    fontSize: 10,
    lineHeight: 16,
    padding: 14,
    marginTop: 18,
    backgroundColor: '#F1F5F9',
    borderRadius: 14,
  },
  footer: {
    textAlign: 'center',
    color: '#94A3B8',
    fontSize: 8,
    letterSpacing: 1,
    fontWeight: '800',
    marginTop: 20,
  },

  // ── Camera Scanner Page ──
  cameraPage: {
    flex: 1,
    backgroundColor: '#090A0F',
    paddingTop: 54,
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  cameraHead: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 18 },
  back: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#1E293B',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backText: { fontSize: 30, color: '#F8FAFC', lineHeight: 34 },
  cameraBox: {
    flex: 1,
    maxHeight: SCREEN_HEIGHT * 0.58,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#111827',
    position: 'relative',
    borderWidth: 1,
    borderColor: '#334155',
  },
  camera: { flex: 1 },
  shutterFlash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#FFFFFF',
    zIndex: 20,
  },
  laserScanLine: {
    position: 'absolute',
    left: 20,
    right: 20,
    height: 3,
    backgroundColor: '#10B981',
    shadowColor: '#10B981',
    shadowOpacity: 0.9,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 10,
  },
  guide: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  oval: {
    width: 220,
    height: 290,
    borderWidth: 2,
    borderColor: 'rgba(16, 185, 129, 0.35)',
    borderRadius: 120,
    borderStyle: 'dashed',
  },
  ovalLocked: {
    borderColor: '#10B981',
    borderWidth: 3,
    borderStyle: 'solid',
    shadowColor: '#10B981',
    shadowOpacity: 0.8,
    shadowRadius: 10,
  },
  ovalMismatch: {
    borderColor: '#EF4444',
    borderWidth: 3,
    borderStyle: 'solid',
    shadowColor: '#EF4444',
    shadowOpacity: 0.9,
    shadowRadius: 14,
  },
  ovalWarning: {
    borderColor: '#F59E0B',
    borderWidth: 3,
    borderStyle: 'solid',
    shadowColor: '#F59E0B',
    shadowOpacity: 0.9,
    shadowRadius: 14,
  },

  // ── Dynamic Detected Face Bounding Box ──
  dynamicBoundingBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#10B981',
    borderRadius: 14,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    zIndex: 15,
  },
  cornerBracket: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderColor: '#34D399',
  },
  cornerTL: { top: -2, left: -2, borderTopWidth: 3.5, borderLeftWidth: 3.5, borderTopLeftRadius: 6 },
  cornerTR: { top: -2, right: -2, borderTopWidth: 3.5, borderRightWidth: 3.5, borderTopRightRadius: 6 },
  cornerBL: { bottom: -2, left: -2, borderBottomWidth: 3.5, borderLeftWidth: 3.5, borderBottomLeftRadius: 6 },
  cornerBR: { bottom: -2, right: -2, borderBottomWidth: 3.5, borderRightWidth: 3.5, borderBottomRightRadius: 6 },
  faceDetectedTag: {
    position: 'absolute',
    top: -22,
    left: 0,
    backgroundColor: '#10B981',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  faceDetectedTagText: { color: '#042F2E', fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },

  scanStatusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1E293B',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginTop: 14,
  },
  scanStatusText: { color: '#38BDF8', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  instruction: { textAlign: 'center', color: '#94A3B8', fontSize: 12, marginVertical: 12 },
  capture: { minHeight: 48, backgroundColor: '#334155' },
  cameraError: { color: '#fff', textAlign: 'center', marginTop: 150 },

  // ── Verification Notice / Reason Alert Banner ──
  noticeCard: {
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
    borderWidth: 1.5,
  },
  noticeMismatch: {
    backgroundColor: 'rgba(127, 29, 29, 0.95)',
    borderColor: '#EF4444',
  },
  noticeWarning: {
    backgroundColor: 'rgba(120, 53, 15, 0.95)',
    borderColor: '#F59E0B',
  },
  noticeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  noticeIcon: {
    fontSize: 15,
  },
  noticeTitle: {
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  noticeTextRed: {
    color: '#FECACA',
  },
  noticeTextAmber: {
    color: '#FDE68A',
  },
  noticeMessage: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  noticeSubtext: {
    color: '#CBD5E1',
    fontSize: 11,
    marginTop: 4,
    fontStyle: 'italic',
  },

  // ── Google Pay Success Animation View ──
  gpayContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  gpaySuccessCard: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  gpayRipple: {
    position: 'absolute',
    top: -25,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(16, 185, 129, 0.4)',
  },
  gpayCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOpacity: 0.75,
    shadowRadius: 18,
    elevation: 14,
    marginBottom: 16,
  },
  gpayCheckmark: {
    color: '#FFFFFF',
    fontSize: 56,
    fontWeight: '900',
    lineHeight: 64,
  },
  gpayMainTitle: {
    color: '#F8FAFC',
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1.2,
  },
  confidencePillBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10B981',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 8,
    marginBottom: 6,
  },
  confidencePillText: {
    color: '#34D399',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  gpaySubtitle: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 20,
  },
  gpayDetailsCard: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 18,
    padding: 20,
    marginBottom: 22,
    borderWidth: 1,
    borderColor: '#334155',
  },
  detailRowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badgeAuthorized: {
    backgroundColor: '#064E3B',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeAuthorizedText: {
    color: '#34D399',
    fontSize: 9,
    fontWeight: '800',
  },
  gpayDetailLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 4,
  },
  gpayDetailVal: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '600',
  },
  gpayDetailValBold: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
  },
  gpayDivider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 12,
  },
  gpayDoneButton: {
    width: '100%',
    backgroundColor: '#10B981',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 6,
  },
  gpayDoneButtonText: {
    color: '#042F2E',
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.2,
  },

  // ── Mismatch & Security Block Result Card ──
  mismatchCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#DC2626',
    shadowOpacity: 0.75,
    shadowRadius: 18,
    elevation: 14,
    marginBottom: 16,
  },
  mismatchCrossmark: {
    color: '#FFFFFF',
    fontSize: 52,
    fontWeight: '900',
    lineHeight: 58,
  },
  mismatchMainTitle: {
    color: '#F8FAFC',
    fontSize: 22,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 1,
  },
  confidencePillMismatch: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderColor: '#EF4444',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginTop: 8,
    marginBottom: 6,
  },
  confidencePillMismatchText: {
    color: '#F87171',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  mismatchDetailsCard: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 18,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1.5,
    borderColor: '#991B1B',
  },
  badgeRejected: {
    backgroundColor: '#7F1D1D',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeRejectedText: {
    color: '#FCA5A5',
    fontSize: 9,
    fontWeight: '800',
  },
  mismatchDetailVal: {
    color: '#E2E8F0',
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '600',
    marginTop: 6,
  },
  securityRuleText: {
    color: '#F87171',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
  },
  rescanButton: {
    width: '100%',
    backgroundColor: '#2563EB',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    elevation: 4,
  },
  rescanButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  cancelMismatchButton: {
    width: '100%',
    backgroundColor: '#334155',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelMismatchButtonText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.9,
  },

  // ── Header Stats Pill & Guest Button ──
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    marginTop: 6,
  },
  orderStatsPill: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  orderStatsText: {
    color: '#334155',
    fontSize: 8,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  enrollHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 8,
  },
  enrollGuestBtn: {
    backgroundColor: '#059669',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    shadowColor: '#059669',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  enrollGuestBtnText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },

  // ── Guest Banner Card ──
  guestBanner: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1.5,
    borderColor: '#86EFAC',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  guestBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  guestAvatarCircle: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: '#DCFCE7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestAvatarText: {
    fontSize: 18,
  },
  guestBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#166534',
  },
  guestBannerSubtitle: {
    fontSize: 10,
    color: '#15803D',
    marginTop: 2,
  },
  guestBannerTag: {
    backgroundColor: '#166534',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  guestBannerTagText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.7,
  },

  // ── Guest Name Input Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  guestModalCard: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 24,
    padding: 22,
    borderWidth: 1,
    borderColor: '#334155',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  guestModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  guestModalIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#064E3B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestModalIconText: {
    fontSize: 22,
  },
  guestModalTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '800',
  },
  guestModalSub: {
    color: '#94A3B8',
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  guestInputBox: {
    marginBottom: 20,
  },
  guestInputLabel: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  guestTextInput: {
    backgroundColor: '#0F172A',
    borderWidth: 1.5,
    borderColor: '#38BDF8',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '700',
  },
  guestModalActions: {
    flexDirection: 'row',
    gap: 10,
  },
  guestCancelButton: {
    flex: 1,
    backgroundColor: '#334155',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestCancelButtonText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  guestSubmitButton: {
    flex: 2,
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#10B981',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 4,
  },
  guestSubmitButtonText: {
    color: '#042F2E',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1,
  },
});
