import { Request, Response, NextFunction } from "express";
import * as premiumService from "../services/premium.service";
import { AppError } from "../lib/errors";

/**
 * Get premium status for the current user
 */
export const getPremiumStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError("UNAUTHORIZED", "Authentication required", 401);
    }

    const status = await premiumService.getUserPremiumStatus(userId);
    
    res.status(200).json({
      status: "success",
      data: status,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Purchase a premium subscription
 */
export const purchasePremium = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = req.user?.id;
    const { planId, paymentMethod } = req.body;

    if (!userId) {
      throw new AppError("UNAUTHORIZED", "Authentication required", 401);
    }

    const result = await premiumService.processPurchase(userId, planId, paymentMethod);

    res.status(201).json({
      status: "success",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};
