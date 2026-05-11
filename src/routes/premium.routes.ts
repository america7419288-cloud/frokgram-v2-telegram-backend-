import { Router } from "express";

import { authMiddleware } from "../middleware/authMiddleware";
import * as premiumController from "../controllers/premium.controller";

const router = Router();

// All premium routes require authentication
router.use(authMiddleware);

router.get("/status", premiumController.getPremiumStatus);
router.post("/purchase", premiumController.purchasePremium);

export default router;
