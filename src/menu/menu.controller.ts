import { Controller, Get, Param } from "@nestjs/common";
import { MenuService } from "./menu.service";

@Controller("public/menu")
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get(":slug")
  bySlug(@Param("slug") slug: string) {
    return this.menu.getBySlug(slug);
  }
}
